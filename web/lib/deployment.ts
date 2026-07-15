import { readFileSync } from "node:fs";
import path from "node:path";
import type { OccultaAddresses, OccultaDeployment } from "@/lib/deployment.types";

export type { OccultaAddresses, OccultaDeployment } from "@/lib/deployment.types";

/**
 * Live Sepolia deployment addresses, read straight from the contracts repo's own deployment
 * artifact — `../deployments/sepolia.json`, one level up from this app — rather than a second,
 * hand-copied constant set that could silently drift from the real deployment.
 *
 * Server-only: uses `node:fs`. The literal fallback below exists only for the case where that
 * file is unreadable at build/run time (e.g. a deploy target that ships `web/` without its
 * sibling `deployments/`). It is the same live, verified Sepolia deployment either way — never
 * mock addresses.
 */

const FALLBACK_ADDRESSES: OccultaAddresses = {
  strategyRegistry: "0x307056cD4800ea5F1E6dA86deA9bAdCe0067bFDc",
  occultaUSDC: "0x058a10E2D029Ea92c484329BdADcFF9a8122B188",
  occultaVaultFactory: "0x3104242b5A1691649Bb92b6192cd755A5fA0Ba16",
  occultaVault: "0xeA1ED96c5c1D089C9203633fF485499C22FEBe9F",
  aaveAdapter: "0x98b6e2071D092adf54B654Bb72c30B807D539e0D",
  uniswapAdapter: "0xE4E50a8fE8E1E0963b4BA9F8f8B39458972E59cA",
  occultaExecutor: "0xBA3A8E6Cba95a7bAAb0BcdB8E6Fb1A4143249831",
  netSettler: "0x8BB7CF578cc1953430e64B1d08A68fEA17e14Feb",
  aavePool: "0x6Ae43d3271ff6888e7Fc43Fd7321a503ff738951",
  swapRouter02: "0x3bFA4769FB09eefC5a80d6E87c3B9C650f7Ae48E",
  usdc: "0x94a9D9AC8a22534E3FaCa9F4e7F2E2cf85d5E4C8",
  weth: "0xC558DBdd856501FCd9aaF1E62eae57A9F0629a3c",
};

const FALLBACK_AGENT_ID = "0";
const FALLBACK_POOL = "0x264B8FB8D89c401cACe37F9501dd072bf35a2E0d" as const;

let cached: OccultaDeployment | null = null;

/** Reads the sibling contracts repo's `deployments/sepolia.json`. Server-side only. */
export function loadDeployment(): OccultaDeployment {
  if (cached) return cached;

  try {
    const deploymentPath = path.join(process.cwd(), "..", "deployments", "sepolia.json");
    const raw = JSON.parse(readFileSync(deploymentPath, "utf8")) as {
      chainId: number;
      agent: { agentId: string };
      addresses: OccultaAddresses;
      pool: { address: OccultaDeployment["pool"] };
    };
    cached = {
      addresses: raw.addresses,
      agentId: BigInt(raw.agent.agentId),
      pool: raw.pool.address,
      chainId: raw.chainId,
    };
  } catch {
    cached = {
      addresses: FALLBACK_ADDRESSES,
      agentId: BigInt(FALLBACK_AGENT_ID),
      pool: FALLBACK_POOL,
      chainId: 11_155_111,
    };
  }

  return cached;
}
