import type { Address } from "viem";
import { formatUnits } from "viem";

import type { AgentContext } from "./context.js";
import { occultaVaultAbi } from "./abi.js";
import { ZERO_HANDLE, decryptOrZero } from "./handles.js";
import { trackTx } from "./tx.js";
import * as log from "./logger.js";

/**
 * Confirmation-depth-aware watcher: indexes `DepositRequest` events up to `head -
 * confirmationDepth` (never the chain tip, so a reorg cannot un-approve a deposit this runtime
 * already acted on) over a bounded look-back window, then approves whatever is still pending for
 * each controller it finds. Mirrors the cVault keeper's watcher/processor split — this process
 * keeps no persistent cursor between restarts (documented in the README as a demo-scope
 * simplification), so each tick re-scans the configured window, which is cheap at Sepolia's
 * traffic and safely idempotent either way: `approveDeposit` on an empty pending bucket is a
 * silent no-op in the contract, never a double-spend.
 */
export async function approvePendingDeposits(ctx: AgentContext): Promise<{ approved: Address[] }> {
  const head = await ctx.publicClient.getBlockNumber();
  const toBlock = head > ctx.confirmationDepth ? head - ctx.confirmationDepth : 0n;
  const fromBlock = toBlock > ctx.depositScanLookbackBlocks ? toBlock - ctx.depositScanLookbackBlocks : 0n;

  const controllers = new Set<Address>();
  const chunk = ctx.depositLogChunkBlocks; // inclusive range size, e.g. 10 blocks == [start, start+9]
  for (let start = fromBlock; start <= toBlock; start += chunk) {
    const end = start + chunk - 1n > toBlock ? toBlock : start + chunk - 1n;
    const logs = await ctx.publicClient.getContractEvents({
      address: ctx.addresses.occultaVault,
      abi: occultaVaultAbi,
      eventName: "DepositRequest",
      fromBlock: start,
      toBlock: end,
    });
    for (const l of logs) {
      const controller = l.args.controller;
      if (controller) controllers.add(controller);
    }
  }

  if (controllers.size === 0) {
    log.info("deposit watcher: no DepositRequest events in the scan window", {
      fromBlock: fromBlock.toString(),
      toBlock: toBlock.toString(),
    });
    return { approved: [] };
  }

  const approved: Address[] = [];
  for (const controller of controllers) {
    try {
      const handle = await ctx.publicClient.readContract({
        address: ctx.addresses.occultaVault,
        abi: occultaVaultAbi,
        functionName: "pendingDepositRequest",
        args: [controller],
      });
      if (handle === ZERO_HANDLE) continue;

      const amount = await decryptOrZero(ctx, handle);
      if (amount <= 0n) continue;

      log.step(`pending deposit found`, { controller, amount: formatUnits(amount, 6) + " USDC" });

      if (ctx.dryRun) {
        log.info(`[DRY RUN] would call approveDeposit(handle, ${controller})`, {
          amount: formatUnits(amount, 6) + " USDC",
        });
        continue;
      }

      const hash = await ctx.walletClient.writeContract({
        address: ctx.addresses.occultaVault,
        abi: occultaVaultAbi,
        functionName: "approveDeposit",
        args: [handle, controller],
        account: ctx.walletClient.account!,
        chain: ctx.walletClient.chain,
      });
      await trackTx(ctx, `approveDeposit:${controller}`, hash);
      approved.push(controller);
    } catch (err) {
      // One bad controller (a stale handle, a transient gateway error) must not block the rest
      // of the sweep — log and move on; the next tick will retry this controller from scratch.
      log.warn(`failed to process pending deposit`, {
        controller,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { approved };
}
