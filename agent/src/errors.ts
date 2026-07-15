/**
 * Coarse error classification for the watch loop's backoff, not a hard safety gate — the actual
 * safety net against double-spending gas is that every state-changing step in `settlement.ts` /
 * `depositWatcher.ts` re-reads on-chain state before it writes (see the resume guard in
 * `runSettlementCycle`). This classification only decides how eagerly the loop retries:
 *
 *  - "transient": the same action will plausibly succeed soon without any state change on our
 *    side (an RPC hiccup, the gateway not having indexed a just-minted handle yet, a rate limit).
 *    The loop backs off exponentially and tries again.
 *  - "permanent": retrying immediately will not help (a contract revert, a misconfigured key,
 *    invalid input). The loop does NOT crash — it logs clearly and falls back to the normal poll
 *    interval, because the surrounding on-chain or policy state may still change by the next
 *    tick (e.g. the strategist reactivates the agent) — but it stops tightening its retry loop
 *    around an error that won't resolve itself.
 */
export type ErrorClass = "transient" | "permanent";

const TRANSIENT_PATTERNS = [
  /fetch failed/i,
  /ECONNRESET/i,
  /ETIMEDOUT/i,
  /ENOTFOUND/i,
  /EAI_AGAIN/i,
  /timeout/i,
  /timed out/i,
  /socket hang up/i,
  /429/,
  /rate.?limit/i,
  /NotYetComputed/i,
  /not.*(ready|indexed|computed)/i,
  /network/i,
  /nonce too low/i,
  /replacement transaction underpriced/i,
];

const PERMANENT_PATTERNS = [
  /revert/i,
  /Unauthorized/i,
  /NotStrategist/i,
  /NotAgentRuntime/i,
  /AgentInactive/i,
  /AlreadyClosed/i,
  /AlreadySettled/i,
  /EmptyEpoch/i,
  /EpochNotClosed/i,
  /insufficient funds/i,
  /invalid private key/i,
  /missing required env var/i,
  /does not look like a 32-byte/i,
];

export function classifyError(err: unknown): ErrorClass {
  const message = err instanceof Error ? err.message : String(err);
  if (PERMANENT_PATTERNS.some((p) => p.test(message))) return "permanent";
  if (TRANSIENT_PATTERNS.some((p) => p.test(message))) return "transient";
  // Unknown shape: default to transient so an unexpected-but-recoverable hiccup still gets
  // retried with backoff instead of silently downgrading to the slow path forever.
  return "transient";
}
