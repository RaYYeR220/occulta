import { createViemHandleClient } from "@iexec-nox/handle";
import { sepoliaReadOnlyWalletClient } from "./chain.js";

type HandleClient = Awaited<ReturnType<typeof createViemHandleClient>>;

let cached: HandleClient | null = null;

/** Lazily creates and caches the Nox handle client used for real `publicDecrypt` calls against
 * the live gateway. Sepolia (chain 11155111) is a network the SDK knows out of the box, so no
 * gateway/subgraph URL override is needed. */
export async function getHandleClient(): Promise<HandleClient> {
  if (cached) return cached;
  cached = await createViemHandleClient(sepoliaReadOnlyWalletClient());
  return cached;
}

/** Retries a live gateway call once after a short delay — the deployed demo observed transient
 * "not a viewer yet" 403s from the gateway indexer that resolve on the very next attempt. */
export async function withRetry<T>(fn: () => Promise<T>, delayMs = 3000): Promise<T> {
  try {
    return await fn();
  } catch {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    return await fn();
  }
}
