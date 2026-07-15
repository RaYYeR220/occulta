import { createPublicClient, createWalletClient, http } from "viem";
import { sepolia } from "viem/chains";

const PUBLIC_FALLBACK_RPC = "https://ethereum-sepolia-rpc.publicnode.com";

export function sepoliaRpcUrl(): string {
  return process.env.SEPOLIA_RPC_URL?.trim() || PUBLIC_FALLBACK_RPC;
}

export function sepoliaPublicClient() {
  return createPublicClient({ chain: sepolia, transport: http(sepoliaRpcUrl()) });
}

/**
 * A read-only wallet client — transport only, no account. Sufficient for `publicDecrypt`, which
 * never signs anything: the handle is already publicly decryptable on-chain by the time it's
 * called. Mirrors `web/app/api/reveal/route.ts`'s exact pattern for the live gateway call.
 */
export function sepoliaReadOnlyWalletClient() {
  return createWalletClient({ chain: sepolia, transport: http(sepoliaRpcUrl()) });
}
