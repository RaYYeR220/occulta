import * as log from "./logger.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Retries a live Nox-gateway call with generous backoff. Handle resolution runs asynchronously
 * inside the TEE runner: a handle minted (or just marked publicly decryptable) by a transaction
 * that only just confirmed is not necessarily indexed and computable yet. The SDK's own internal
 * retry is tuned for an already-resolved handle, not this window. Bounded, not infinite — if the
 * gateway genuinely stalls, this reports exactly where and gives up rather than spinning forever.
 *
 * Ported verbatim in spirit from `scripts/demo.ts`'s `withGatewayRetry`, which is the proven
 * pattern for every live gateway call in this repo.
 */
export async function withGatewayRetry<T>(
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
    } catch (err) {
      lastError = err;
      const message = err instanceof Error ? err.message : String(err);
      log.warn(`gateway not ready, retrying`, { label, attempt: i, of: attempts, message });
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
