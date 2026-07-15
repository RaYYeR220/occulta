import { createPublicClient, http } from "viem";
import { sepolia } from "viem/chains";

const PUBLIC_FALLBACK_RPC = "https://ethereum-sepolia-rpc.publicnode.com";

export function sepoliaRpcUrl(): string {
  return process.env.NEXT_PUBLIC_SEPOLIA_RPC_URL?.trim() || PUBLIC_FALLBACK_RPC;
}

export function sepoliaPublicClient() {
  return createPublicClient({
    chain: sepolia,
    transport: http(sepoliaRpcUrl()),
  });
}
