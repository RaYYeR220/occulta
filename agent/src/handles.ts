import type { AgentContext } from "./context.js";
import { withGatewayRetry } from "./gatewayRetry.js";

export const ZERO_HANDLE = `0x${"00".repeat(32)}` as const;

/** An uninitialized Nox handle is the zero handle; the SDK rejects decrypting it outright, so
 * every off-chain read of a possibly-untouched bucket goes through this short-circuit instead. */
export async function decryptOrZero(ctx: AgentContext, handle: `0x${string}`): Promise<bigint> {
  if (handle === ZERO_HANDLE) return 0n;
  const { value } = await withGatewayRetry(`decrypt(${handle})`, () => ctx.handleClient.decrypt(handle));
  return value as bigint;
}
