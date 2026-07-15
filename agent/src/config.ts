import "dotenv/config";
import { parseUnits } from "viem";
import { loadDeployment, type OccultaAddresses } from "./deployment.js";

export interface AgentConfig {
  rpcUrl: string;
  privateKey: `0x${string}`;
  dryRun: boolean;
  runOnce: boolean;

  pollIntervalMs: number;
  epochCadenceMs: number;
  confirmationDepth: bigint;
  maxBackoffMs: number;
  depositScanLookbackBlocks: bigint;
  depositLogChunkBlocks: bigint;

  slippageBps: bigint;
  maxIntentUsdc: bigint; // 6-decimals
  maxIntentWeth: bigint; // 18-decimals
  minTradeUsdc: bigint; // 6-decimals
  minTradeWeth: bigint; // 18-decimals
  executorUsdcBuffer: bigint; // 6-decimals

  agentId: bigint;
  chainId: number;
  addresses: OccultaAddresses;
}

function envStr(name: string, fallback?: string): string {
  const v = process.env[name]?.trim();
  if (v) return v;
  if (fallback !== undefined) return fallback;
  throw new Error(`missing required env var ${name}`);
}

function envBool(name: string, fallback: boolean): boolean {
  const v = process.env[name]?.trim().toLowerCase();
  if (!v) return fallback;
  return v === "true" || v === "1" || v === "yes";
}

function envInt(name: string, fallback: number): number {
  const v = process.env[name]?.trim();
  if (!v) return fallback;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`env var ${name} must be a positive number, got "${v}"`);
  return n;
}

function envBigIntUnits(name: string, fallback: string, decimals: number): bigint {
  const v = process.env[name]?.trim() || fallback;
  return parseUnits(v, decimals);
}

const PUBLIC_FALLBACK_RPC = "https://ethereum-sepolia-rpc.publicnode.com";

export function loadConfig(): AgentConfig {
  const deployment = loadDeployment();

  const rawKey = envStr("RUNTIME_PRIVATE_KEY");
  const privateKey = (rawKey.startsWith("0x") ? rawKey : `0x${rawKey}`) as `0x${string}`;
  if (privateKey.length !== 66) {
    throw new Error(
      `RUNTIME_PRIVATE_KEY does not look like a 32-byte hex private key (got length ${privateKey.length})`,
    );
  }

  const agentIdEnv = process.env.AGENT_ID?.trim();

  return {
    rpcUrl: envStr("SEPOLIA_RPC_URL", PUBLIC_FALLBACK_RPC),
    privateKey,
    dryRun: envBool("DRY_RUN", true),
    runOnce: envBool("RUN_ONCE", false),

    pollIntervalMs: envInt("POLL_INTERVAL_MS", 15_000),
    epochCadenceMs: envInt("EPOCH_CADENCE_MS", 300_000),
    confirmationDepth: BigInt(envInt("CONFIRMATION_DEPTH", 2)),
    maxBackoffMs: envInt("MAX_BACKOFF_MS", 120_000),
    // Conservative defaults: many RPC providers cap `eth_getLogs` to a small block range on
    // their free tier (Alchemy's free tier, for one, caps it at 10 blocks per call) — a wide
    // lookback scanned in tiny chunks would mean hundreds of sequential round-trips per tick.
    // A production deployment would persist a watermark and only ever scan forward from it
    // instead of re-scanning a fixed backward window every tick (see depositWatcher.ts's header);
    // raise both via env if your RPC provider allows a wider range.
    depositScanLookbackBlocks: BigInt(envInt("DEPOSIT_SCAN_LOOKBACK_BLOCKS", 300)),
    depositLogChunkBlocks: BigInt(envInt("DEPOSIT_LOG_CHUNK_BLOCKS", 10)),

    slippageBps: BigInt(envInt("SLIPPAGE_BPS", 300)),
    maxIntentUsdc: envBigIntUnits("MAX_INTENT_USDC", "20", 6),
    maxIntentWeth: envBigIntUnits("MAX_INTENT_WETH", "0.002", 18),
    minTradeUsdc: envBigIntUnits("MIN_TRADE_USDC", "1", 6),
    minTradeWeth: envBigIntUnits("MIN_TRADE_WETH", "0.0002", 18),
    executorUsdcBuffer: envBigIntUnits("EXECUTOR_USDC_BUFFER", "5", 6),

    agentId: agentIdEnv ? BigInt(agentIdEnv) : deployment.agentId,
    chainId: deployment.chainId,
    addresses: deployment.addresses,
  };
}
