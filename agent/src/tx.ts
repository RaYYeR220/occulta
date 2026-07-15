import type { Hash, TransactionReceipt } from "viem";
import type { AgentContext } from "./context.js";
import * as log from "./logger.js";

export function etherscanTx(hash: string): string {
  return `https://sepolia.etherscan.io/tx/${hash}`;
}

/**
 * Waits for a transaction, logs its outcome, and throws (rather than silently swallowing) on a
 * revert — the caller's `classifyError` will tag that as permanent, and `settlement.ts` /
 * `depositWatcher.ts` never retry the identical write blindly: the next tick re-reads on-chain
 * state before attempting anything again.
 */
export async function trackTx(ctx: AgentContext, label: string, hash: Hash): Promise<TransactionReceipt> {
  log.step(`tx sent: ${label}`, { hash, link: etherscanTx(hash) });
  const receipt = await ctx.publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") {
    throw new Error(`${label} reverted (tx ${hash}) — see ${etherscanTx(hash)}`);
  }
  log.step(`tx confirmed: ${label}`, {
    hash,
    block: receipt.blockNumber.toString(),
    gasUsed: receipt.gasUsed.toString(),
    link: etherscanTx(hash),
  });
  return receipt;
}
