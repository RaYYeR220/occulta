import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Address } from "viem";

/**
 * Live Sepolia deployment addresses, read straight from the contracts repo's own deployment
 * artifact — `../../deployments/sepolia.json`, two levels up from this file's compiled location
 * (`mcp/dist/deployment.js` -> `mcp/` -> `occulta/`). Resolved from `import.meta.url` rather than
 * `process.cwd()` because an MCP client spawns this process with an arbitrary working directory.
 *
 * The literal fallback below is the same live, verified Sepolia deployment, not a mock — it only
 * matters if this package ever ships without its sibling `deployments/` directory.
 */

export interface OccultaAddresses {
  strategyRegistry: Address;
  occultaUSDC: Address;
  occultaVaultFactory: Address;
  occultaVault: Address;
  aaveAdapter: Address;
  uniswapAdapter: Address;
  occultaExecutor: Address;
  netSettler: Address;
}

export interface OccultaDeployment {
  addresses: OccultaAddresses;
  agentId: bigint;
  chainId: number;
}

const FALLBACK_ADDRESSES: OccultaAddresses = {
  strategyRegistry: "0x307056cD4800ea5F1E6dA86deA9bAdCe0067bFDc",
  occultaUSDC: "0x058a10E2D029Ea92c484329BdADcFF9a8122B188",
  occultaVaultFactory: "0x3104242b5A1691649Bb92b6192cd755A5fA0Ba16",
  occultaVault: "0xeA1ED96c5c1D089C9203633fF485499C22FEBe9F",
  aaveAdapter: "0x98b6e2071D092adf54B654Bb72c30B807D539e0D",
  uniswapAdapter: "0xE4E50a8fE8E1E0963b4BA9F8f8B39458972E59cA",
  occultaExecutor: "0xBA3A8E6Cba95a7bAAb0BcdB8E6Fb1A4143249831",
  netSettler: "0x8BB7CF578cc1953430e64B1d08A68fEA17e14Feb",
};

const FALLBACK_AGENT_ID = "0";
const FALLBACK_CHAIN_ID = 11_155_111;

let cached: OccultaDeployment | null = null;

export function loadDeployment(): OccultaDeployment {
  if (cached) return cached;

  try {
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
  } catch {
    cached = {
      addresses: FALLBACK_ADDRESSES,
      agentId: BigInt(FALLBACK_AGENT_ID),
      chainId: FALLBACK_CHAIN_ID,
    };
  }

  return cached;
}
