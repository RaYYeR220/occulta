import type { Address } from "viem";

export interface OccultaAddresses {
  strategyRegistry: Address;
  occultaUSDC: Address;
  occultaVaultFactory: Address;
  occultaVault: Address;
  aaveAdapter: Address;
  uniswapAdapter: Address;
  occultaExecutor: Address;
  netSettler: Address;
  aavePool: Address;
  swapRouter02: Address;
  usdc: Address;
  weth: Address;
}

export interface OccultaDeployment {
  addresses: OccultaAddresses;
  agentId: bigint;
  pool: Address;
  chainId: number;
}
