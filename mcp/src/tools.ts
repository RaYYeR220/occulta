import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { aaveAdapterAbi, netSettlerAbi, strategyRegistryAbi } from "./abi.js";
import { sepoliaPublicClient } from "./chain.js";
import { loadDeployment } from "./deployment.js";
import { formatHealthFactor, formatUsdBase, formatUsdcUnits } from "./format.js";
import { getHandleClient, withRetry } from "./handle.js";

function json(value: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(value, (_key, v) => (typeof v === "bigint" ? v.toString() : v), 2),
      },
    ],
  };
}

export function registerTools(server: McpServer) {
  server.registerTool(
    "list_agents",
    {
      title: "List Occulta agents",
      description:
        "Lists every strategy agent registered on Occulta's live StrategyRegistry on ETH Sepolia. " +
        "Returns each agent's PUBLIC metadata only: id, display name, mandate, strategist, off-chain " +
        "runtime address, and active flag. The strategist's sealed trading policy is never returned " +
        "by this or any tool — that opacity is the product's core guarantee.",
      inputSchema: {},
    },
    async () => {
      const deployment = loadDeployment();
      const client = sepoliaPublicClient();

      const count = await client.readContract({
        address: deployment.addresses.strategyRegistry,
        abi: strategyRegistryAbi,
        functionName: "agentCount",
      });

      const agents = [];
      for (let i = 0n; i < count; i++) {
        const meta = await client.readContract({
          address: deployment.addresses.strategyRegistry,
          abi: strategyRegistryAbi,
          functionName: "metaOf",
          args: [i],
        });
        agents.push({
          agentId: i.toString(),
          name: meta.name,
          mandate: meta.mandate,
          strategist: meta.strategist,
          runtime: meta.runtime,
          active: meta.active,
        });
      }

      return json({
        chainId: deployment.chainId,
        strategyRegistry: deployment.addresses.strategyRegistry,
        agentCount: count,
        agents,
      });
    },
  );

  server.registerTool(
    "agent_status",
    {
      title: "Occulta agent status",
      description:
        "Live status for one Occulta agent: its current netting epoch, whether the latest epoch " +
        "has settled, and its REAL executed position on Aave V3 (collateral/debt in USD, health " +
        "factor) via AaveAdapter. This is the agent's actual on-chain footprint, not a claim.",
      inputSchema: {
        agentId: z.number().int().min(0).default(0).describe("Agent id from StrategyRegistry. Defaults to 0, the live demo agent."),
      },
    },
    async ({ agentId }) => {
      const id = BigInt(agentId);
      const deployment = loadDeployment();
      const client = sepoliaPublicClient();

      const meta = await client.readContract({
        address: deployment.addresses.strategyRegistry,
        abi: strategyRegistryAbi,
        functionName: "metaOf",
        args: [id],
      });

      const currentEpoch = await client.readContract({
        address: deployment.addresses.netSettler,
        abi: netSettlerAbi,
        functionName: "currentEpoch",
        args: [id],
      });

      let latestEpoch: { epoch: bigint; intentCount: bigint; closed: boolean; settled: boolean } | null = null;
      if (currentEpoch > 0n) {
        const epoch = currentEpoch - 1n;
        const [intentCount, closed, settled] = await client.readContract({
          address: deployment.addresses.netSettler,
          abi: netSettlerAbi,
          functionName: "epochStateOf",
          args: [id, epoch],
        });
        latestEpoch = { epoch, intentCount, closed, settled };
      }

      const [totalCollateralBase, totalDebtBase, availableBorrowsBase] = await client.readContract({
        address: deployment.addresses.aaveAdapter,
        abi: aaveAdapterAbi,
        functionName: "accountData",
      });
      const healthFactor = await client.readContract({
        address: deployment.addresses.aaveAdapter,
        abi: aaveAdapterAbi,
        functionName: "healthFactor",
      });

      return json({
        agentId: id,
        name: meta.name,
        mandate: meta.mandate,
        strategist: meta.strategist,
        runtime: meta.runtime,
        active: meta.active,
        currentEpoch,
        latestEpoch,
        position: {
          collateralUsd: formatUsdBase(totalCollateralBase),
          debtUsd: formatUsdBase(totalDebtBase),
          availableBorrowsUsd: formatUsdBase(availableBorrowsBase),
          healthFactor: formatHealthFactor(healthFactor),
        },
        aaveAdapter: deployment.addresses.aaveAdapter,
      });
    },
  );

  server.registerTool(
    "reveal_epoch_net",
    {
      title: "Reveal a settled epoch's aggregate net order",
      description:
        "Runs a REAL publicDecrypt against the live Nox gateway for a SETTLED netting epoch, and " +
        "returns the plaintext aggregate net (e.g. '30 USDC, BUY'). This aggregate — magnitude and " +
        "direction — is the ONLY value this epoch ever discloses: the individual depositor intents " +
        "that netted to it are never publicly decryptable. Use verify_confidentiality to check that " +
        "claim live against the same epoch.",
      inputSchema: {
        agentId: z.number().int().min(0).default(0).describe("Agent id from StrategyRegistry."),
        epoch: z.number().int().min(0).describe("Epoch number to reveal. Must already be closed and settled."),
      },
    },
    async ({ agentId, epoch }) => {
      const id = BigInt(agentId);
      const ep = BigInt(epoch);
      const deployment = loadDeployment();
      const client = sepoliaPublicClient();

      const [intentCount, closed, settled] = await client.readContract({
        address: deployment.addresses.netSettler,
        abi: netSettlerAbi,
        functionName: "epochStateOf",
        args: [id, ep],
      });

      if (!closed || !settled) {
        return json({
          ok: false,
          agentId: id,
          epoch: ep,
          intentCount,
          closed,
          settled,
          message: !closed
            ? "This epoch has not closed yet — nothing has been revealed."
            : "This epoch closed but has not settled yet — the proof-verified plaintext does not exist on-chain yet.",
        });
      }

      const [netHandle, directionHandle] = await Promise.all([
        client.readContract({
          address: deployment.addresses.netSettler,
          abi: netSettlerAbi,
          functionName: "netOf",
          args: [id, ep],
        }),
        client.readContract({
          address: deployment.addresses.netSettler,
          abi: netSettlerAbi,
          functionName: "netDirectionOf",
          args: [id, ep],
        }),
      ]);

      const [netPublic, directionPublic] = await Promise.all([
        client.readContract({
          address: deployment.addresses.netSettler,
          abi: netSettlerAbi,
          functionName: "isPubliclyDecryptable",
          args: [netHandle],
        }),
        client.readContract({
          address: deployment.addresses.netSettler,
          abi: netSettlerAbi,
          functionName: "isPubliclyDecryptable",
          args: [directionHandle],
        }),
      ]);

      if (!netPublic || !directionPublic) {
        return json({
          ok: false,
          agentId: id,
          epoch: ep,
          message:
            "Epoch settled on-chain, but the gateway has not yet indexed the public-decryption grant. Retry shortly.",
        });
      }

      const handleClient = await getHandleClient();
      const [netResult, directionResult] = await Promise.all([
        withRetry(() => handleClient.publicDecrypt(netHandle)),
        withRetry(() => handleClient.publicDecrypt(directionHandle)),
      ]);

      const netRaw = netResult.value as bigint;
      const isBuy = directionResult.value as boolean;

      return json({
        ok: true,
        agentId: id,
        epoch: ep,
        intentCount,
        net: { raw: netRaw, usdc: formatUsdcUnits(netRaw), direction: isBuy ? "BUY" : "SELL" },
        summary: `${formatUsdcUnits(netRaw)} USDC, ${isBuy ? "BUY" : "SELL"}`,
        handles: { net: netHandle, direction: directionHandle },
        netSettler: deployment.addresses.netSettler,
        privacyNote:
          `This aggregate is the ONLY thing this epoch discloses to anyone outside the settler and ` +
          `the agent's runtime. The ${intentCount.toString()} individual intent(s) that netted to it — ` +
          `their sizes AND their sides — were never made publicly decryptable. Call verify_confidentiality ` +
          `for agentId ${id} epoch ${ep} to check that live, not just on the strength of this claim.`,
      });
    },
  );

  server.registerTool(
    "verify_confidentiality",
    {
      title: "Verify Occulta's confidentiality guarantee",
      description:
        "Demonstrates the privacy claim for real, against the live deployed contracts and the live " +
        "Nox gateway: reads NetSettler's running buyTotal/sellTotal ciphertexts (the closest on-chain " +
        "artifact to an individual intent — no getter ever returns a raw intent handle by design), " +
        "checks isPubliclyDecryptable on them (expect false), and attempts a real publicDecrypt against " +
        "the live gateway (expect rejection). Contrasts that against the epoch's aggregate net/direction, " +
        "which ARE publicly decryptable once closed. Returns a structured verdict, not an assertion.",
      inputSchema: {
        agentId: z.number().int().min(0).default(0).describe("Agent id from StrategyRegistry."),
        epoch: z.number().int().min(0).describe("Epoch number to test. Must have at least one submitted intent."),
      },
    },
    async ({ agentId, epoch }) => {
      const id = BigInt(agentId);
      const ep = BigInt(epoch);
      const deployment = loadDeployment();
      const client = sepoliaPublicClient();

      const [intentCount, closed, settled] = await client.readContract({
        address: deployment.addresses.netSettler,
        abi: netSettlerAbi,
        functionName: "epochStateOf",
        args: [id, ep],
      });

      if (intentCount === 0n) {
        return json({
          agentId: id,
          epoch: ep,
          intentCount,
          verdict: "NO_DATA",
          message:
            "No intent has been submitted into this epoch yet, so there is no live ciphertext to test " +
            "against the gateway. By design (NetSettler.sol), an individual intent's size and side are " +
            "granted only allowThis(settler) + allow(runtime) in _accumulate — allowPublicDecryption is " +
            "called nowhere on them, anywhere in the contract.",
        });
      }

      const [buyTotalHandle, sellTotalHandle] = await Promise.all([
        client.readContract({
          address: deployment.addresses.netSettler,
          abi: netSettlerAbi,
          functionName: "buyTotalOf",
          args: [id, ep],
        }),
        client.readContract({
          address: deployment.addresses.netSettler,
          abi: netSettlerAbi,
          functionName: "sellTotalOf",
          args: [id, ep],
        }),
      ]);

      const [buyTotalPublic, sellTotalPublic] = await Promise.all([
        client.readContract({
          address: deployment.addresses.netSettler,
          abi: netSettlerAbi,
          functionName: "isPubliclyDecryptable",
          args: [buyTotalHandle],
        }),
        client.readContract({
          address: deployment.addresses.netSettler,
          abi: netSettlerAbi,
          functionName: "isPubliclyDecryptable",
          args: [sellTotalHandle],
        }),
      ]);

      const handleClient = await getHandleClient();
      let rejected = false;
      let gatewayMessage = "";
      try {
        await handleClient.publicDecrypt(buyTotalHandle);
        gatewayMessage = "publicDecrypt unexpectedly SUCCEEDED on a sealed handle — this would be a privacy bug.";
      } catch (err) {
        rejected = true;
        gatewayMessage = err instanceof Error ? err.message : String(err);
      }

      let aggregate: Record<string, unknown> | null = null;
      if (closed) {
        const [netHandle, directionHandle] = await Promise.all([
          client.readContract({
            address: deployment.addresses.netSettler,
            abi: netSettlerAbi,
            functionName: "netOf",
            args: [id, ep],
          }),
          client.readContract({
            address: deployment.addresses.netSettler,
            abi: netSettlerAbi,
            functionName: "netDirectionOf",
            args: [id, ep],
          }),
        ]);
        const [netPublic, directionPublic] = await Promise.all([
          client.readContract({
            address: deployment.addresses.netSettler,
            abi: netSettlerAbi,
            functionName: "isPubliclyDecryptable",
            args: [netHandle],
          }),
          client.readContract({
            address: deployment.addresses.netSettler,
            abi: netSettlerAbi,
            functionName: "isPubliclyDecryptable",
            args: [directionHandle],
          }),
        ]);
        aggregate = {
          netHandle,
          directionHandle,
          netIsPubliclyDecryptable: netPublic,
          directionIsPubliclyDecryptable: directionPublic,
        };
      }

      const verdict = !buyTotalPublic && !sellTotalPublic && rejected ? "CONFIDENTIAL" : "ANOMALY_DETECTED";

      return json({
        agentId: id,
        epoch: ep,
        intentCount,
        closed,
        settled,
        componentTotals: {
          note:
            "buyTotal/sellTotal are the running encrypted sums every intent in this epoch is folded " +
            "into (NetSettler._accumulate). No getter ever returns a single raw intent handle — " +
            "IntentSubmitted deliberately carries none — so these totals are the closest real, " +
            "on-chain ciphertext to 'what an intent looks like from outside'. Checked live below.",
          buyTotalHandle,
          sellTotalHandle,
          buyTotalIsPubliclyDecryptable: buyTotalPublic,
          sellTotalIsPubliclyDecryptable: sellTotalPublic,
        },
        liveGatewayRejectionTest: {
          handleTested: buyTotalHandle,
          attemptedPublicDecrypt: true,
          rejected,
          gatewayMessage,
        },
        aggregate,
        verdict,
        contractReference:
          "NetSettler.sol: allowPublicDecryption is called exactly twice in the entire contract, both " +
          "inside closeEpoch, on `net` and `buyWins` only. Every intent's amount and side, and the " +
          "running buyTotal/sellTotal they feed, are never granted public-decrypt access.",
      });
    },
  );

  server.registerTool(
    "live_proof",
    {
      title: "Occulta live deployment proof",
      description:
        "Returns Occulta's live ETH Sepolia deployment: all 8 verified contract addresses with " +
        "Etherscan links, the settle() transaction that netted 3 sealed intents into 30 USDC BUY and " +
        "executed real Uniswap V3 + Aave V3 in one transaction, and the resulting collateral delta. " +
        "Also reads AaveAdapter's CURRENT position live, so the numbers are fresh, not just historical.",
      inputSchema: {},
    },
    async () => {
      const deployment = loadDeployment();
      const client = sepoliaPublicClient();

      const contracts = [
        { name: "StrategyRegistry", address: deployment.addresses.strategyRegistry },
        { name: "OccultaUSDC", address: deployment.addresses.occultaUSDC },
        { name: "OccultaVaultFactory", address: deployment.addresses.occultaVaultFactory },
        { name: "OccultaVault", address: deployment.addresses.occultaVault },
        { name: "AaveAdapter", address: deployment.addresses.aaveAdapter },
        { name: "UniswapAdapter", address: deployment.addresses.uniswapAdapter },
        { name: "OccultaExecutor", address: deployment.addresses.occultaExecutor },
        { name: "NetSettler", address: deployment.addresses.netSettler },
      ].map((c) => ({ ...c, etherscan: `https://sepolia.etherscan.io/address/${c.address}#code` }));

      let liveNow: Record<string, string> | null = null;
      try {
        const [totalCollateralBase, totalDebtBase] = await client.readContract({
          address: deployment.addresses.aaveAdapter,
          abi: aaveAdapterAbi,
          functionName: "accountData",
        });
        const healthFactor = await client.readContract({
          address: deployment.addresses.aaveAdapter,
          abi: aaveAdapterAbi,
          functionName: "healthFactor",
        });
        liveNow = {
          collateralUsd: formatUsdBase(totalCollateralBase),
          debtUsd: formatUsdBase(totalDebtBase),
          healthFactor: formatHealthFactor(healthFactor),
        };
      } catch {
        liveNow = null;
      }

      return json({
        chainId: deployment.chainId,
        network: "sepolia",
        contracts,
        settleTx: {
          hash: "0xa7509b8f5c516f36683aa58d3079370c4f4995f7461d8b62abbcba303f2a5653",
          etherscan:
            "https://sepolia.etherscan.io/tx/0xa7509b8f5c516f36683aa58d3079370c4f4995f7461d8b62abbcba303f2a5653",
          description:
            "Two-proof-verified settle(): 3 sealed intents (buy 20, buy 15, sell 5 USDC) netted to " +
            "30 USDC BUY, executed as a real Uniswap V3 swap then supplied to real Aave V3 — one transaction.",
        },
        demoRun: {
          revealedNet: "30 USDC, BUY",
          uniswapSwap: "30 USDC -> 0.009764942720128096 WETH",
          aaveCollateralDelta: { before: "$0.00", after: "$39.05977088" },
          healthFactorAfter: "no debt (type(uint256).max)",
          transactions: 14,
          reverts: 0,
        },
        liveNow,
        claim: "8/8 verified, zero mocks",
      });
    },
  );
}
