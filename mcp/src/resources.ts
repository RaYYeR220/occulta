import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { strategyRegistryAbi } from "./abi.js";
import { sepoliaPublicClient } from "./chain.js";
import { loadDeployment } from "./deployment.js";

function toJson(value: unknown) {
  return JSON.stringify(value, (_key, v) => (typeof v === "bigint" ? v.toString() : v), 2);
}

export function registerResources(server: McpServer) {
  server.registerResource(
    "occulta-deployment",
    "occulta://deployment",
    {
      title: "Occulta Sepolia deployment",
      description: "Live, verified Occulta contract addresses and chain id on ETH Sepolia.",
      mimeType: "application/json",
    },
    async (uri) => ({
      contents: [{ uri: uri.href, text: toJson(loadDeployment()) }],
    }),
  );

  server.registerResource(
    "occulta-agents",
    "occulta://agents",
    {
      title: "Occulta registered agents",
      description: "Live list of every registered agent's public StrategyRegistry metadata.",
      mimeType: "application/json",
    },
    async (uri) => {
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

      return { contents: [{ uri: uri.href, text: toJson(agents) }] };
    },
  );
}
