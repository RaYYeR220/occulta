import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { network } from "hardhat";
import { createViemHandleClient } from "@iexec-nox/handle";
import { formatEther, formatUnits, parseAbi, type Address, type Hash } from "viem";

/**
 * Task 10c — the live end-to-end demo of the full confidential DeFi flow, run against real
 * ETH Sepolia: a depositor funds a confidential vault with real USDC, three encrypted trading
 * intents net down to one revealed aggregate order inside the Nox TEE, and that aggregate — and
 * only that aggregate — settles against the real, unmodified Aave V3 Pool and Uniswap V3
 * SwapRouter02. One operator plays every role (depositor, strategist, agent runtime), exactly
 * as the deployed agent's runtime already is (see deployments/sepolia.json's `agentRuntime`) —
 * a demo simplification, not a limitation of the contracts, which gate every step by role
 * regardless of how many distinct keys happen to hold those roles today.
 *
 * Usage: pnpm demo:sepolia  ->  hardhat run scripts/demo.ts --network sepolia
 *
 * Every contract address is read from deployments/sepolia.json — the authoritative live
 * deployment artifact — rather than a second, hand-copied set of constants that could drift
 * from it.
 *
 * Phase A funds the confidential vault: real USDC in, an encrypted vault share out, every step
 * decrypted and printed so the transcript is checkable, not merely asserted.
 *
 * Phase B is the product's core claim. Three encrypted intents (buy 20, buy 15, sell 5) are
 * folded into one epoch inside NetSettler; before the epoch closes, an individual intent is
 * shown to be neither publicly decryptable nor readable by anyone outside the settler and the
 * runtime. Closing the epoch reveals exactly one number — the net (30, a buy) — and settling it
 * forwards that proof-verified plaintext to OccultaExecutor, which swaps USDC for WETH on real
 * Uniswap V3 and supplies the WETH to real Aave V3 as collateral.
 *
 * Phase C reads the resulting Aave position and Uniswap swap back off-chain to prove the trade
 * actually happened, not merely that a transaction succeeded.
 *
 * The vault's assets and the executor's are deliberately NOT connected on-chain in this
 * deployment shape — the vault-to-executor unwrap bridge is out of scope here (see
 * OccultaExecutor.sol's own header) — so Phase B pre-funds the executor with a direct faucet
 * mint, called out explicitly at the point it happens.
 *
 * Every on-chain write is single-shot: a revert stops the script immediately with the decoded
 * reason and the reverting tx hash, rather than being retried. Only off-chain reads against the
 * live Nox gateway (decrypt / publicDecrypt) are retried, and only because handle resolution
 * runs asynchronously inside the TEE runner — a handle minted in a transaction that just
 * confirmed is not necessarily computable yet.
 */

const AMOUNT_DECIMALS = 6; // Aave-USDC
const WRAP_AMOUNT = 50_000_000n; // 50 USDC — Phase A's confidential deposit
const EXECUTOR_FUND_AMOUNT = 30_000_000n; // 30 USDC — pre-funds Phase B's net BUY capital
const INTENT_BUY_1 = 20_000_000n; // 20 USDC, buy
const INTENT_BUY_2 = 15_000_000n; // 15 USDC, buy
const INTENT_SELL_1 = 5_000_000n; // 5 USDC, sell
const EXPECTED_NET = 30_000_000n; // 20 + 15 - 5 = 30 USDC, buy
const SLIPPAGE_BPS = 300n; // 3% off the pre-trade QuoterV2 quote
const FEE_TIER = 10000; // the executor's configured Uniswap V3 fee tier — cross-checked below

const NOX_COMPUTE_ADDRESS: Address = "0x24Ef36Ec5b626D7DCD09a98F3083c2758F0F77bF";
const ZERO_HANDLE = `0x${"00".repeat(32)}` as const;

const erc20Abi = parseAbi([
  "function balanceOf(address account) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
]);
const faucetAbi = parseAbi([
  "function mint(address token, address to, uint256 amount) returns (uint256)",
]);
const noxComputeAbi = parseAbi(["function allow(bytes32 handle, address account) external"]);
const quoterAbi = parseAbi([
  "function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96) params) returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)",
]);

interface DeploymentArtifact {
  agent: { agentId: string };
  addresses: {
    strategyRegistry: Address;
    occultaUSDC: Address;
    occultaVault: Address;
    aaveAdapter: Address;
    uniswapAdapter: Address;
    occultaExecutor: Address;
    netSettler: Address;
    aavePool: Address;
    quoterV2: Address;
    aaveFaucet: Address;
    usdc: Address;
    weth: Address;
  };
}

function etherscanTx(hash: string): string {
  return `https://sepolia.etherscan.io/tx/${hash}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Retries a live-gateway call with generous backoff. Handle resolution runs asynchronously
 * inside the TEE runner: a handle minted in the transaction that just confirmed is not
 * necessarily indexed and computed yet. The SDK's own internal retry (3 attempts, ~1s/2s/4s) is
 * tuned for an already-resolved handle, not this window, so this wraps every decrypt /
 * publicDecrypt call made against a handle whose confirming transaction just landed. Bounded,
 * not infinite: if the gateway genuinely stalls, this reports exactly where and gives up rather
 * than spinning forever.
 */
async function withGatewayRetry<T>(
  label: string,
  attempt: () => Promise<T>,
  options: { attempts?: number; delayMs?: number; maxDelayMs?: number } = {},
): Promise<T> {
  const attempts = options.attempts ?? 20;
  const maxDelay = options.maxDelayMs ?? 15_000;
  let delay = options.delayMs ?? 3_000;
  let lastError: unknown;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await attempt();
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      console.log(`    [gateway not ready, retry ${i}/${attempts}] ${label}: ${message}`);
      if (i === attempts) break;
      await sleep(delay);
      delay = Math.min(delay * 1.5, maxDelay);
    }
  }
  throw new Error(
    `${label} did not resolve against the live Nox gateway after ${attempts} attempts. Last error: ` +
      `${lastError instanceof Error ? lastError.message : String(lastError)}`,
  );
}

async function main() {
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const deploymentPath = path.join(scriptDir, "..", "deployments", "sepolia.json");
  const deployment = JSON.parse(readFileSync(deploymentPath, "utf8")) as DeploymentArtifact;
  const ADDR = deployment.addresses;
  const AGENT_ID = BigInt(deployment.agent.agentId);

  const connection = await network.create();
  const { viem, networkName } = connection;
  const [operator] = await viem.getWalletClients();
  const publicClient = await viem.getPublicClient();
  const chainId = await publicClient.getChainId();

  if (networkName !== "sepolia" || chainId !== 11155111) {
    throw new Error(
      `this demo must run against live ETH Sepolia — got network "${networkName}" (chainId ${chainId})`,
    );
  }

  console.log(`== Occulta live demo — ETH Sepolia ==`);
  console.log(`operator (plays depositor + strategist + agent runtime): ${operator.account.address}`);
  console.log(
    `ETH balance: ${formatEther(await publicClient.getBalance({ address: operator.account.address }))} ETH`,
  );
  console.log(`agentId: ${AGENT_ID}`);

  const handleClient = await createViemHandleClient(operator);

  const registry = await viem.getContractAt("StrategyRegistry", ADDR.strategyRegistry);
  const occultaUSDC = await viem.getContractAt("OccultaUSDC", ADDR.occultaUSDC);
  const vault = await viem.getContractAt("OccultaVault", ADDR.occultaVault);
  const netSettler = await viem.getContractAt("NetSettler", ADDR.netSettler);
  const executor = await viem.getContractAt("OccultaExecutor", ADDR.occultaExecutor);
  const aaveAdapter = await viem.getContractAt("AaveAdapter", ADDR.aaveAdapter);

  // Pre-flight: confirm this operator is genuinely the agent's authorized, active runtime before
  // spending a single unit of gas — a mismatch here would otherwise surface many transactions
  // later as a cryptic NetSettlerNotAgentRuntime / NetSettlerAgentInactive revert.
  const meta = (await registry.read.metaOf([AGENT_ID])) as {
    strategist: Address;
    runtime: Address;
    name: string;
    mandate: string;
    active: boolean;
  };
  console.log(`registry.metaOf(${AGENT_ID}): runtime=${meta.runtime}, active=${meta.active}, name="${meta.name}"`);
  if (meta.runtime.toLowerCase() !== operator.account.address.toLowerCase() || !meta.active) {
    throw new Error(
      `agent ${AGENT_ID} is not runnable by this operator (runtime=${meta.runtime}, active=${meta.active}) — ` +
        `aborting before spending any gas`,
    );
  }
  const executorFeeTier = await executor.read.fee();
  console.log(`executor.fee() = ${executorFeeTier} (expected ${FEE_TIER})`);
  if (Number(executorFeeTier) !== FEE_TIER) {
    throw new Error(`executor fee tier mismatch: on-chain ${executorFeeTier}, expected ${FEE_TIER}`);
  }

  const txHashes: Record<string, Hash> = {};

  async function sendAndTrack(label: string, hash: Hash) {
    console.log(`  tx: ${label} -> ${hash}`);
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") {
      throw new Error(`${label} REVERTED (tx ${hash}) — see ${etherscanTx(hash)}`);
    }
    txHashes[label] = hash;
    console.log(`    confirmed in block ${receipt.blockNumber}, gasUsed ${receipt.gasUsed} -> ${etherscanTx(hash)}`);
    return receipt;
  }

  async function decryptOrZero(handle: `0x${string}`): Promise<bigint> {
    if (handle === ZERO_HANDLE) return 0n;
    const { value } = await withGatewayRetry(`decrypt(${handle})`, () => handleClient.decrypt(handle));
    return value as bigint;
  }

  async function ensureUsdcBalance(target: Address, minBalance: bigint, label: string) {
    const balance = (await publicClient.readContract({
      address: ADDR.usdc,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [target],
    })) as bigint;
    if (balance >= minBalance) {
      console.log(
        `  ${label} already holds ${formatUnits(balance, AMOUNT_DECIMALS)} USDC (>= ${formatUnits(minBalance, AMOUNT_DECIMALS)} needed) — skipping faucet mint`,
      );
      return;
    }
    const need = minBalance - balance;
    console.log(`  faucet-minting ${formatUnits(need, AMOUNT_DECIMALS)} USDC to ${label} (${target})`);
    const hash = await operator.writeContract({
      address: ADDR.aaveFaucet,
      abi: faucetAbi,
      functionName: "mint",
      args: [ADDR.usdc, target, need],
    });
    await sendAndTrack(`faucetMint:${label}`, hash);
  }

  // ===========================================================================================
  // Phase A — depositor funds the confidential vault
  // ===========================================================================================
  console.log(`\n[Phase A] depositor funds the confidential vault with real USDC`);

  console.log(`\n[A1] faucet-mint Aave-USDC if the operator is short`);
  await ensureUsdcBalance(operator.account.address, WRAP_AMOUNT, "operator");

  console.log(`\n[A2] USDC.approve(OccultaUSDC, ${formatUnits(WRAP_AMOUNT, AMOUNT_DECIMALS)}) + OccultaUSDC.wrap(operator, amount)`);
  await sendAndTrack(
    "approveUsdcToOccultaUSDC",
    await operator.writeContract({
      address: ADDR.usdc,
      abi: erc20Abi,
      functionName: "approve",
      args: [ADDR.occultaUSDC, WRAP_AMOUNT],
    }),
  );
  const confidentialBalanceBeforeWrap = await decryptOrZero(
    (await occultaUSDC.read.confidentialBalanceOf([operator.account.address])) as `0x${string}`,
  );
  await sendAndTrack(
    "wrapUsdc",
    await occultaUSDC.write.wrap([operator.account.address, WRAP_AMOUNT], { account: operator.account }),
  );
  const balanceHandleAfterWrap = (await occultaUSDC.read.confidentialBalanceOf([
    operator.account.address,
  ])) as `0x${string}`;
  const confidentialBalanceAfterWrap = await decryptOrZero(balanceHandleAfterWrap);
  console.log(
    `  decrypted confidentialBalanceOf(operator): ${formatUnits(confidentialBalanceBeforeWrap, AMOUNT_DECIMALS)} -> ` +
      `${formatUnits(confidentialBalanceAfterWrap, AMOUNT_DECIMALS)} USDC`,
  );
  if (confidentialBalanceAfterWrap - confidentialBalanceBeforeWrap !== WRAP_AMOUNT) {
    throw new Error(
      `wrap did not credit the expected amount: delta ${confidentialBalanceAfterWrap - confidentialBalanceBeforeWrap}, expected ${WRAP_AMOUNT}`,
    );
  }

  console.log(`\n[A3] OccultaUSDC.setOperator(vault, deadline) + NoxCompute.allow(balanceHandle, vault)`);
  const operatorDeadline = Math.floor(Date.now() / 1000) + 24 * 3600;
  await sendAndTrack(
    "setOperatorVaultOnOccultaUSDC",
    await occultaUSDC.write.setOperator([ADDR.occultaVault, operatorDeadline], { account: operator.account }),
  );
  await sendAndTrack(
    "noxComputeAllowBalanceHandleToVault",
    await operator.writeContract({
      address: NOX_COMPUTE_ADDRESS,
      abi: noxComputeAbi,
      functionName: "allow",
      args: [balanceHandleAfterWrap, ADDR.occultaVault],
    }),
  );

  console.log(`\n[A4] vault.requestDeposit(balanceHandle, operator, operator)`);
  await sendAndTrack(
    "requestDeposit",
    await vault.write.requestDeposit(
      [balanceHandleAfterWrap, operator.account.address, operator.account.address],
      { account: operator.account },
    ),
  );
  const pendingHandle = (await vault.read.pendingDepositRequest([operator.account.address])) as `0x${string}`;
  const pendingAmount = await decryptOrZero(pendingHandle);
  console.log(`  decrypted pendingDepositRequest(operator): ${formatUnits(pendingAmount, AMOUNT_DECIMALS)} USDC`);
  if (pendingAmount !== WRAP_AMOUNT) {
    throw new Error(
      `pending deposit is ${pendingAmount}, expected ${WRAP_AMOUNT} — a previous partial run may have left ` +
        `state behind; aborting before spending more gas`,
    );
  }

  console.log(`\n[A5] agent approves the deposit and claims the confidential vault share (same operator key)`);
  await sendAndTrack(
    "approveDeposit",
    await vault.write.approveDeposit([pendingHandle, operator.account.address], { account: operator.account }),
  );
  await sendAndTrack(
    "claimDeposit",
    await vault.write.deposit([operator.account.address, operator.account.address], { account: operator.account }),
  );
  const shareHandle = (await vault.read.confidentialBalanceOf([operator.account.address])) as `0x${string}`;
  const shareBalance = await decryptOrZero(shareHandle);
  console.log(`  decrypted confidential vault share balance: ${shareBalance} (raw ovUSDC units, virtual-share offset applied)`);
  if (shareBalance <= 0n) {
    throw new Error(`vault share balance is zero after claim — the deposit lifecycle did not complete correctly`);
  }

  // ===========================================================================================
  // Phase B — confidential netting: three encrypted intents in, one revealed aggregate out
  // ===========================================================================================
  console.log(`\n[Phase B] confidential netting reveals ONLY the aggregate order`);

  console.log(
    `\n[B1] faucet-mint USDC directly to OccultaExecutor — pre-funds the net BUY; the vault-to-` +
      `executor unwrap bridge is intentionally out of scope on-chain in this deployment, so this is ` +
      `the one deliberate pre-funding step`,
  );
  await ensureUsdcBalance(ADDR.occultaExecutor, EXECUTOR_FUND_AMOUNT, "executor");

  const workingEpoch = (await netSettler.read.currentEpoch([AGENT_ID])) as bigint;
  const [existingIntentCount, existingClosed] = (await netSettler.read.epochStateOf([
    AGENT_ID,
    workingEpoch,
  ])) as [bigint, boolean, boolean];
  if (existingIntentCount > 0n || existingClosed) {
    throw new Error(
      `epoch ${workingEpoch} is not fresh (intentCount=${existingIntentCount}, closed=${existingClosed}) — ` +
        `a previous run may have left partial state behind; aborting before submitting new intents`,
    );
  }

  console.log(
    `\n[B2] submitting 3 fresh-encrypted intents into epoch ${workingEpoch}: buy 20, buy 15, sell 5 -> expect net 30 buy`,
  );
  interface SubmittedIntent {
    label: string;
    amountHandle: `0x${string}`;
    sideHandle: `0x${string}`;
    hash: Hash;
  }
  const intents: SubmittedIntent[] = [];
  const intentPlan: readonly [string, bigint, boolean][] = [
    ["buy 20 USDC", INTENT_BUY_1, true],
    ["buy 15 USDC", INTENT_BUY_2, true],
    ["sell 5 USDC", INTENT_SELL_1, false],
  ];
  for (const [label, amount, isBuy] of intentPlan) {
    const size = await withGatewayRetry(`encryptInput(${label} size)`, () =>
      handleClient.encryptInput(amount, "uint256", netSettler.address),
    );
    const side = await withGatewayRetry(`encryptInput(${label} side)`, () =>
      handleClient.encryptInput(isBuy, "bool", netSettler.address),
    );
    const hash = await netSettler.write.submitIntent(
      [AGENT_ID, size.handle, size.handleProof, side.handle, side.handleProof],
      { account: operator.account },
    );
    await sendAndTrack(`submitIntent:${label}`, hash);
    intents.push({ label, amountHandle: size.handle, sideHandle: side.handle, hash });
  }

  console.log(`\n[B3] privacy proof — an individual intent is not publicly decryptable`);
  const sampleIntent = intents[0]!;
  const amountPublic = await netSettler.read.isPubliclyDecryptable([sampleIntent.amountHandle]);
  const sidePublic = await netSettler.read.isPubliclyDecryptable([sampleIntent.sideHandle]);
  console.log(`  netSettler.isPubliclyDecryptable("${sampleIntent.label}" amount handle) = ${amountPublic}`);
  console.log(`  netSettler.isPubliclyDecryptable("${sampleIntent.label}" side handle) = ${sidePublic}`);
  if (amountPublic || sidePublic) {
    throw new Error(
      `an individual intent handle is publicly decryptable on-chain — the privacy guarantee is broken, aborting`,
    );
  }
  let publicDecryptOnIntentRejected = false;
  try {
    await handleClient.publicDecrypt(sampleIntent.amountHandle);
  } catch (error) {
    publicDecryptOnIntentRejected = true;
    console.log(
      `  publicDecrypt("${sampleIntent.label}" amount handle) correctly REJECTED: ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!publicDecryptOnIntentRejected) {
    throw new Error(`publicDecrypt succeeded on an individual intent handle — the privacy guarantee is broken, aborting`);
  }

  console.log(`\n[B4] closeEpoch(agentId) — nets the epoch and marks ONLY the aggregate publicly decryptable`);
  await sendAndTrack(
    "closeEpoch",
    await netSettler.write.closeEpoch([AGENT_ID], { account: operator.account }),
  );
  const netHandle = (await netSettler.read.netOf([AGENT_ID, workingEpoch])) as `0x${string}`;
  const directionHandle = (await netSettler.read.netDirectionOf([AGENT_ID, workingEpoch])) as `0x${string}`;
  console.log(`  net handle: ${netHandle}`);
  console.log(`  direction handle: ${directionHandle}`);
  console.log(
    `  isPubliclyDecryptable(net) = ${await netSettler.read.isPubliclyDecryptable([netHandle])}, ` +
      `isPubliclyDecryptable(direction) = ${await netSettler.read.isPubliclyDecryptable([directionHandle])}`,
  );

  console.log(`\n[B5] publicDecrypt(net) + publicDecrypt(direction) — the ONLY values this epoch ever reveals`);
  const netResult = await withGatewayRetry("publicDecrypt(net)", () => handleClient.publicDecrypt(netHandle));
  const directionResult = await withGatewayRetry("publicDecrypt(direction)", () =>
    handleClient.publicDecrypt(directionHandle),
  );
  const netPlaintext = netResult.value as bigint;
  const netIsBuy = directionResult.value as boolean;
  console.log(`  REVEALED NET: ${formatUnits(netPlaintext, AMOUNT_DECIMALS)} USDC, direction = ${netIsBuy ? "BUY" : "SELL"}`);
  if (netPlaintext !== EXPECTED_NET || netIsBuy !== true) {
    throw new Error(
      `revealed net (${netPlaintext}, buy=${netIsBuy}) does not match the expected 30 USDC buy — aborting before settling`,
    );
  }

  console.log(`\n[B6] QuoterV2 staticCall for minOut (${Number(SLIPPAGE_BPS) / 100}% slippage tolerance)`);
  const quote = await publicClient.simulateContract({
    address: ADDR.quoterV2,
    abi: quoterAbi,
    functionName: "quoteExactInputSingle",
    args: [{ tokenIn: ADDR.usdc, tokenOut: ADDR.weth, amountIn: netPlaintext, fee: FEE_TIER, sqrtPriceLimitX96: 0n }],
    account: operator.account,
  });
  const [quotedWethOut] = quote.result;
  const minOut = (quotedWethOut * (10_000n - SLIPPAGE_BPS)) / 10_000n;
  console.log(
    `  quoted ${formatUnits(netPlaintext, AMOUNT_DECIMALS)} USDC -> ${formatEther(quotedWethOut)} WETH; ` +
      `minOut = ${formatEther(minOut)} WETH`,
  );

  console.log(`\n[Phase C - before] Aave collateral snapshot, taken before settlement`);
  const accountDataBefore = (await aaveAdapter.read.accountData()) as readonly [bigint, bigint, bigint, bigint];
  console.log(
    `  totalCollateralBase: ${accountDataBefore[0]} (8-decimal USD base), healthFactor: ${accountDataBefore[3]}`,
  );

  console.log(
    `\n[B7] settle(agentId, epoch, netProof, directionProof, minOut) -> forwards the proven net to ` +
      `executor.executeNet -> real Uniswap V3 swap + real Aave V3 supply`,
  );
  const settleReceipt = await sendAndTrack(
    "settle",
    await netSettler.write.settle(
      [AGENT_ID, workingEpoch, netResult.decryptionProof, directionResult.decryptionProof, minOut],
      { account: operator.account },
    ),
  );

  const settledEvents = await netSettler.getEvents.Settled(
    {},
    { fromBlock: settleReceipt.blockNumber, toBlock: settleReceipt.blockNumber },
  );
  const executedEvents = await executor.getEvents.Executed(
    {},
    { fromBlock: settleReceipt.blockNumber, toBlock: settleReceipt.blockNumber },
  );
  const settledEvent = settledEvents[0];
  const executedEvent = executedEvents[0];
  if (settledEvent) {
    console.log(
      `  Settled event: netPlaintext=${settledEvent.args.netPlaintext}, netIsBuy=${settledEvent.args.netIsBuy}`,
    );
  }
  if (executedEvent) {
    console.log(
      `  Executed event: netAmount=${executedEvent.args.netAmount}, netIsBuy=${executedEvent.args.netIsBuy}, ` +
        `resultAmount=${executedEvent.args.resultAmount} (WETH supplied to Aave)`,
    );
  }

  // ===========================================================================================
  // Phase C — real DeFi happened
  // ===========================================================================================
  console.log(`\n[Phase C] proof real Aave + Uniswap execution happened`);
  const accountDataAfter = (await aaveAdapter.read.accountData()) as readonly [bigint, bigint, bigint, bigint];
  const collateralDelta = accountDataAfter[0] - accountDataBefore[0];
  console.log(
    `  totalCollateralBase: ${accountDataBefore[0]} -> ${accountDataAfter[0]} (delta ${collateralDelta >= 0n ? "+" : ""}${collateralDelta})`,
  );
  console.log(`  healthFactor after: ${accountDataAfter[3]}`);

  const wethSupplied = executedEvent?.args.resultAmount as bigint | undefined;
  console.log(
    `  Uniswap swap: ${formatUnits(netPlaintext, AMOUNT_DECIMALS)} USDC -> ` +
      `${wethSupplied !== undefined ? formatEther(wethSupplied) : "unknown"} WETH, then supplied to Aave V3 as collateral`,
  );
  if (collateralDelta <= 0n) {
    console.warn(
      `  WARNING: Aave totalCollateralBase did not increase — check the Executed/Settled events and the ` +
        `settle tx receipt above for what actually happened`,
    );
  }

  // ===========================================================================================
  // Summary
  // ===========================================================================================
  console.log(`\n== PROOF SUMMARY ==`);
  console.log(`revealed net: ${formatUnits(netPlaintext, AMOUNT_DECIMALS)} USDC (${netIsBuy ? "BUY" : "SELL"})`);
  console.log(`Aave collateral delta: ${collateralDelta >= 0n ? "+" : ""}${collateralDelta} (8-decimal USD base)`);
  console.log(
    `Uniswap swap: ${formatUnits(netPlaintext, AMOUNT_DECIMALS)} USDC -> ` +
      `${wethSupplied !== undefined ? formatEther(wethSupplied) : "unknown"} WETH`,
  );
  console.log(`transactions:`);
  for (const [label, hash] of Object.entries(txHashes)) {
    console.log(`  ${label}: ${hash} -> ${etherscanTx(hash)}`);
  }
  console.log(`\n== demo complete ==`);
}

main().catch((err) => {
  console.error(`\ndemo.ts failed:`);
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
