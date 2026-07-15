import type { Address } from "viem";
import type { OccultaAddresses } from "@/lib/deployment.types";

/** Client-safe constants and helpers — no `node:fs`, safe to import from client components. */

export const SETTLE_TX_HASH =
  "0xa7509b8f5c516f36683aa58d3079370c4f4995f7461d8b62abbcba303f2a5653" as const;
export const CLOSE_EPOCH_TX_HASH =
  "0xa260e1dc2da6000b9dd3940a85be13cf5205294784905c8e1bfd72b4b7af1bc4" as const;
export const SAMPLE_INTENT_TX_HASH =
  "0x3394d45e8f6182b2b5070ca3d99eea0b4b5f763647f5db606bcefe91e85af034" as const;
export const REGISTER_AGENT_TX_HASH =
  "0x2f90fd5ff4b822e4a1c00eacc0b75a3ad37284028347f1a19773b8eb87ad7046" as const;

export function etherscanAddress(address: Address): string {
  return `https://sepolia.etherscan.io/address/${address}#code`;
}

export function etherscanTx(hash: string): string {
  return `https://sepolia.etherscan.io/tx/${hash}`;
}

export function verifiedContracts(addresses: OccultaAddresses) {
  return [
    { name: "StrategyRegistry", address: addresses.strategyRegistry },
    { name: "OccultaUSDC", address: addresses.occultaUSDC },
    { name: "OccultaVaultFactory", address: addresses.occultaVaultFactory },
    { name: "OccultaVault", address: addresses.occultaVault },
    { name: "AaveAdapter", address: addresses.aaveAdapter },
    { name: "UniswapAdapter", address: addresses.uniswapAdapter },
    { name: "OccultaExecutor", address: addresses.occultaExecutor },
    { name: "NetSettler", address: addresses.netSettler },
  ] as const;
}
