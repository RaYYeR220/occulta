import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Address } from "viem";

/**
 * Live Sepolia deployment addresses, read straight from the contracts repo's own artifact —
 * `../../deployments/sepolia.json`, two levels up from this file's compiled location
 * (`agent/dist/deployment.js` -> `agent/` -> `occulta/`). Resolved from `import.meta.url` rather
 * than `process.cwd()` so this works no matter where the process is launched from. Mirrors
 * `mcp/src/deployment.ts` and `web/lib/deployment.ts` exactly — same artifact, same convention.
 */

export interface OccultaAddresses {
  strategyRegistry: Address;
  occultaUSDC: Address;
  occultaVault: Address;
  aaveAdapter: Address;
  uniswapAdapter: Address;
  occultaExecutor: Address;
  netSettler: Address;
  aavePool: Address;
  quoterV2: Address;
  aaveFaucet: Address;
  usdc: Address;
  weth: Address;
}

export interface OccultaDeployment {
  addresses: OccultaAddresses;
  agentId: bigint;
  chainId: number;
}

let cached: OccultaDeployment | null = null;

export function loadDeployment(): OccultaDeployment {
  if (cached) return cached;

  const here = path.dirname(fileURLToPath(import.meta.url));
  const deploymentPath = path.join(here, "..", "..", "deployments", "sepolia.json");
  const raw = JSON.parse(readFileSync(deploymentPath, "utf8")) as {
    chainId: number;
    agent: { agentId: string };
    addresses: OccultaAddresses;
  };

  cached = {
    addresses: raw.addresses,
    agentId: BigInt(raw.agent.agentId),
    chainId: raw.chainId,
  };
  return cached;
}
