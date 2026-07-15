import { formatUnits } from "viem";

import type { AgentContext } from "./context.js";
import {
  aaveAdapterAbi,
  erc20Abi,
  faucetAbi,
  netSettlerAbi,
  occultaExecutorAbi,
  occultaVaultAbi,
  quoterAbi,
  strategyRegistryAbi,
} from "./abi.js";
import { decryptOrZero } from "./handles.js";
import { withGatewayRetry } from "./gatewayRetry.js";
import { trackTx } from "./tx.js";
import { readPolicy } from "./policy.js";
import { computeDecision, type RebalanceDecision } from "./strategy.js";
import * as log from "./logger.js";

/**
 * Reads every live input the strategy rule needs and returns its decision. Pure w.r.t. chain
 * state: no transaction is sent here, only reads and off-chain decrypts — safe to call in
 * DRY_RUN or as the first half of a live cycle.
 */
export async function computeStrategyDecision(ctx: AgentContext): Promise<RebalanceDecision> {
  const policy = await readPolicy(ctx);

  const capitalHandle = await ctx.publicClient.readContract({
    address: ctx.addresses.occultaVault,
    abi: occultaVaultAbi,
    functionName: "confidentialTotalAssets",
  });
  const capitalUsdc6 = await decryptOrZero(ctx, capitalHandle);

  const [currentDeployedUsd8, totalDebtBase] = await ctx.publicClient.readContract({
    address: ctx.addresses.aaveAdapter,
    abi: aaveAdapterAbi,
    functionName: "accountData",
  });

  // Invariant check, not a trade input: this strategy never borrows (OccultaExecutor.executeNet
  // only ever calls AaveAdapter.supply/withdraw), so live debt should always read zero. Surfacing
  // a violation here would mean something outside this runtime's own logic moved the position.
  if (totalDebtBase > 0n) {
    log.warn("unexpected non-zero Aave debt for a strategy that never borrows", {
      totalDebtBase: totalDebtBase.toString(),
      maxLeverageBps: policy.maxLeverageBps.toString(),
    });
  }

  const quote = await ctx.publicClient.simulateContract({
    address: ctx.addresses.quoterV2,
    abi: quoterAbi,
    functionName: "quoteExactInputSingle",
    args: [
      {
        tokenIn: ctx.addresses.weth,
        tokenOut: ctx.addresses.usdc,
        amountIn: 10n ** 18n,
        fee: ctx.feeTier,
        sqrtPriceLimitX96: 0n,
      },
    ],
    account: ctx.walletClient.account,
  });
  const [usdcPerOneWeth6] = quote.result;

  log.info("live market snapshot", {
    capitalUsdc6: formatUnits(capitalUsdc6, 6) + " USDC",
    currentDeployedUsd8: formatUnits(currentDeployedUsd8, 8) + " USD",
    usdcPerOneWeth6: formatUnits(usdcPerOneWeth6, 6) + " USDC/WETH",
  });

  return computeDecision({
    policy,
    capitalUsdc6,
    currentDeployedUsd8,
    usdcPerOneWeth6,
    maxIntentUsdc: ctx.maxIntentUsdc,
    maxIntentWeth: ctx.maxIntentWeth,
    minTradeUsdc: ctx.minTradeUsdc,
    minTradeWeth: ctx.minTradeWeth,
  });
}

/**
 * The full settlement cycle for one tick. Idempotent and resume-safe: every step re-reads
 * on-chain state before acting, so a process crash or an overlapping tick can never submit into
 * a closed epoch, close an already-closed epoch, or settle an already-settled one — the guard is
 * the live `epochStateOf` read at the top of each branch, not an in-memory flag.
 */
export async function runSettlementCycle(ctx: AgentContext): Promise<void> {
  const meta = await ctx.publicClient.readContract({
    address: ctx.addresses.strategyRegistry,
    abi: strategyRegistryAbi,
    functionName: "metaOf",
    args: [ctx.agentId],
  });
  const runtimeAddress = ctx.walletClient.account!.address;
  if (meta.runtime.toLowerCase() !== runtimeAddress.toLowerCase() || !meta.active) {
    throw new Error(
      `this key is not the active runtime for agent ${ctx.agentId} (registered runtime=${meta.runtime}, active=${meta.active})`,
    );
  }

  const currentEpoch = await ctx.publicClient.readContract({
    address: ctx.addresses.netSettler,
    abi: netSettlerAbi,
    functionName: "currentEpoch",
    args: [ctx.agentId],
  });

  // Resume guard: an epoch closed but never settled by a prior, possibly-crashed run outranks
  // opening new work — it already carries a live-revealed aggregate that must not be abandoned.
  if (currentEpoch > 0n) {
    const prevEpoch = currentEpoch - 1n;
    const [, prevClosed, prevSettled] = await ctx.publicClient.readContract({
      address: ctx.addresses.netSettler,
      abi: netSettlerAbi,
      functionName: "epochStateOf",
      args: [ctx.agentId, prevEpoch],
    });
    if (prevClosed && !prevSettled) {
      log.info(`resuming unsettled epoch ${prevEpoch} left over from a previous cycle`);
      await revealAndSettle(ctx, prevEpoch);
      return;
    }
  }

  const [intentCount, closed] = await ctx.publicClient.readContract({
    address: ctx.addresses.netSettler,
    abi: netSettlerAbi,
    functionName: "epochStateOf",
    args: [ctx.agentId, currentEpoch],
  });
  if (closed) {
    // Structurally shouldn't happen (currentEpoch is by definition the open one), but this is
    // the single most important guard in the file — never act past a closed epoch on a stale read.
    log.warn(`epoch ${currentEpoch} reported open but is already closed on-chain — skipping this tick`);
    return;
  }

  if (intentCount === 0n) {
    const decision = await computeStrategyDecision(ctx);
    log.step("strategy decision", {
      action: decision.action,
      reason: decision.reason,
      intentAmount: decision.intentAmount.toString(),
      driftBps: decision.driftBps.toString(),
    });

    if (decision.action === "hold") {
      log.info(`no rebalance this cycle: ${decision.reason}`);
      return;
    }

    if (ctx.dryRun) {
      log.info(`[DRY RUN] would submit a fresh-encrypted intent`, {
        action: decision.action,
        amount: decision.intentAmount.toString(),
      });
      log.info(
        `[DRY RUN] would then closeEpoch(${ctx.agentId}), publicDecrypt the revealed aggregate, quote ` +
          `minOut, and settle — the aggregate net only exists after a real closeEpoch inside the Nox TEE, ` +
          `so it cannot be previewed further without sending that transaction`,
      );
      return;
    }

    await submitFreshIntent(ctx, decision);
  } else {
    log.info(`epoch ${currentEpoch} already has ${intentCount} intent(s) from a previous cycle — proceeding to close`);
  }

  await closeEpochOnChain(ctx, currentEpoch);
  await revealAndSettle(ctx, currentEpoch);
}

async function submitFreshIntent(ctx: AgentContext, decision: RebalanceDecision): Promise<void> {
  const isBuy = decision.action === "buy";
  const size = await withGatewayRetry("encryptInput(intent size)", () =>
    ctx.handleClient.encryptInput(decision.intentAmount, "uint256", ctx.addresses.netSettler),
  );
  const side = await withGatewayRetry("encryptInput(intent side)", () =>
    ctx.handleClient.encryptInput(isBuy, "bool", ctx.addresses.netSettler),
  );
  const hash = await ctx.walletClient.writeContract({
    address: ctx.addresses.netSettler,
    abi: netSettlerAbi,
    functionName: "submitIntent",
    args: [ctx.agentId, size.handle, size.handleProof, side.handle, side.handleProof],
    account: ctx.walletClient.account!,
    chain: ctx.walletClient.chain,
  });
  await trackTx(ctx, "submitIntent", hash);
}

async function closeEpochOnChain(ctx: AgentContext, epoch: bigint): Promise<void> {
  const hash = await ctx.walletClient.writeContract({
    address: ctx.addresses.netSettler,
    abi: netSettlerAbi,
    functionName: "closeEpoch",
    args: [ctx.agentId],
    account: ctx.walletClient.account!,
    chain: ctx.walletClient.chain,
  });
  await trackTx(ctx, `closeEpoch:${epoch}`, hash);
}

/**
 * Reveals a closed epoch's aggregate (a real `publicDecrypt` against the live gateway — a read,
 * safe to run even in DRY_RUN) and, unless DRY_RUN, proves it on-chain via `settle`, which
 * forwards it to `OccultaExecutor` for the real Uniswap + Aave legs.
 */
async function revealAndSettle(ctx: AgentContext, epoch: bigint): Promise<void> {
  const netHandle = await ctx.publicClient.readContract({
    address: ctx.addresses.netSettler,
    abi: netSettlerAbi,
    functionName: "netOf",
    args: [ctx.agentId, epoch],
  });
  const directionHandle = await ctx.publicClient.readContract({
    address: ctx.addresses.netSettler,
    abi: netSettlerAbi,
    functionName: "netDirectionOf",
    args: [ctx.agentId, epoch],
  });

  const netResult = await withGatewayRetry("publicDecrypt(net)", () => ctx.handleClient.publicDecrypt(netHandle));
  const directionResult = await withGatewayRetry("publicDecrypt(direction)", () =>
    ctx.handleClient.publicDecrypt(directionHandle),
  );
  const netPlaintext = netResult.value as bigint;
  const netIsBuy = directionResult.value as boolean;

  log.step(`epoch ${epoch} revealed aggregate`, {
    net: netPlaintext.toString(),
    direction: netIsBuy ? "BUY" : "SELL",
  });

  let minOut = 0n;
  if (netPlaintext > 0n) {
    const [tokenIn, tokenOut] = netIsBuy
      ? [ctx.addresses.usdc, ctx.addresses.weth]
      : [ctx.addresses.weth, ctx.addresses.usdc];
    const quote = await ctx.publicClient.simulateContract({
      address: ctx.addresses.quoterV2,
      abi: quoterAbi,
      functionName: "quoteExactInputSingle",
      args: [{ tokenIn, tokenOut, amountIn: netPlaintext, fee: ctx.feeTier, sqrtPriceLimitX96: 0n }],
      account: ctx.walletClient.account,
    });
    const [quotedOut] = quote.result;
    minOut = (quotedOut * (10_000n - ctx.slippageBps)) / 10_000n;
    log.step("settlement quote", {
      amountIn: netPlaintext.toString(),
      quotedOut: quotedOut.toString(),
      minOut: minOut.toString(),
      slippageBps: ctx.slippageBps.toString(),
    });
  } else {
    log.info(`epoch ${epoch} netted to zero — nothing to execute; settle still records the proof on-chain`);
  }

  if (ctx.dryRun) {
    log.info(`[DRY RUN] would call settle(${ctx.agentId}, ${epoch}, netProof, directionProof, ${minOut})`, {
      revealedNet: netPlaintext.toString(),
      direction: netIsBuy ? "BUY" : "SELL",
      minOut: minOut.toString(),
    });
    return;
  }

  if (netPlaintext > 0n && netIsBuy) {
    // The vault-to-executor unwrap bridge is out of scope on-chain in this deployment shape
    // (see scripts/demo.ts's own header) — the executor's USDC has to come from somewhere before
    // its Uniswap leg can run. This runtime pre-funds it directly via the same testnet faucet
    // scripts/demo.ts uses, exactly the workaround that script documents, not a new one.
    await ensureExecutorUsdcBuffer(ctx, netPlaintext);
  }

  const hash = await ctx.walletClient.writeContract({
    address: ctx.addresses.netSettler,
    abi: netSettlerAbi,
    functionName: "settle",
    args: [ctx.agentId, epoch, netResult.decryptionProof, directionResult.decryptionProof, minOut],
    account: ctx.walletClient.account!,
    chain: ctx.walletClient.chain,
  });
  const receipt = await trackTx(ctx, `settle:${epoch}`, hash);

  const [settledEvents, executedEvents] = await Promise.all([
    ctx.publicClient.getContractEvents({
      address: ctx.addresses.netSettler,
      abi: netSettlerAbi,
      eventName: "Settled",
      fromBlock: receipt.blockNumber,
      toBlock: receipt.blockNumber,
    }),
    ctx.publicClient.getContractEvents({
      address: ctx.addresses.occultaExecutor,
      abi: occultaExecutorAbi,
      eventName: "Executed",
      fromBlock: receipt.blockNumber,
      toBlock: receipt.blockNumber,
    }),
  ]);

  log.step(`epoch ${epoch} settled`, {
    settled: settledEvents[0]?.args,
    executed: executedEvents[0]?.args,
  });
}

async function ensureExecutorUsdcBuffer(ctx: AgentContext, neededForSwap: bigint): Promise<void> {
  const balance = await ctx.publicClient.readContract({
    address: ctx.addresses.usdc,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [ctx.addresses.occultaExecutor],
  });
  if (balance >= neededForSwap) {
    log.info(`executor already holds enough USDC`, {
      balance: formatUnits(balance, 6) + " USDC",
      needed: formatUnits(neededForSwap, 6) + " USDC",
    });
    return;
  }

  const need = neededForSwap + ctx.executorUsdcBuffer - balance;
  log.step(`faucet-minting USDC to the executor`, {
    amount: formatUnits(need, 6) + " USDC",
    executor: ctx.addresses.occultaExecutor,
  });
  const hash = await ctx.walletClient.writeContract({
    address: ctx.addresses.aaveFaucet,
    abi: faucetAbi,
    functionName: "mint",
    args: [ctx.addresses.usdc, ctx.addresses.occultaExecutor, need],
    account: ctx.walletClient.account!,
    chain: ctx.walletClient.chain,
  });
  await trackTx(ctx, "faucetMint:executor", hash);
}
