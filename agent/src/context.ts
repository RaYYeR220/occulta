import { createPublicClient, createWalletClient, http, type PublicClient, type WalletClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import { createViemHandleClient } from "@iexec-nox/handle";

import type { AgentConfig } from "./config.js";
import { occultaExecutorAbi } from "./abi.js";
import * as log from "./logger.js";

type HandleClient = Awaited<ReturnType<typeof createViemHandleClient>>;

/** Everything a cycle needs, bundled once at startup: live clients, the sealed-policy decrypt
 * client, and the flattened config. Every module in this service takes this as its first
 * argument rather than threading clients and config separately. */
export interface AgentContext extends AgentConfig {
  publicClient: PublicClient;
  walletClient: WalletClient;
  handleClient: HandleClient;
  feeTier: number;
}

const EXPECTED_FEE_TIER = 10_000;

export async function buildContext(cfg: AgentConfig): Promise<AgentContext> {
  const account = privateKeyToAccount(cfg.privateKey);
  const publicClient = createPublicClient({ chain: sepolia, transport: http(cfg.rpcUrl) });
  const walletClient = createWalletClient({ chain: sepolia, transport: http(cfg.rpcUrl), account });

  const chainId = await publicClient.getChainId();
  if (chainId !== 11_155_111) {
    throw new Error(`this runtime only drives live ETH Sepolia — got chainId ${chainId}`);
  }

  const handleClient = await createViemHandleClient(walletClient);

  const feeTier = await publicClient.readContract({
    address: cfg.addresses.occultaExecutor,
    abi: occultaExecutorAbi,
    functionName: "fee",
  });
  if (feeTier !== EXPECTED_FEE_TIER) {
    log.warn(`executor fee tier differs from the expected constant — using the live value`, {
      live: feeTier,
      expected: EXPECTED_FEE_TIER,
    });
  }

  log.info("agent context ready", {
    runtime: account.address,
    chainId,
    agentId: cfg.agentId.toString(),
    feeTier,
    dryRun: cfg.dryRun,
  });

  return { ...cfg, publicClient, walletClient, handleClient, feeTier };
}
