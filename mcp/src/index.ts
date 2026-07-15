#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { registerResources } from "./resources.js";
import { registerTools } from "./tools.js";

const server = new McpServer({
  name: "occulta",
  version: "0.1.0",
  description:
    "Confidential DeFi strategy state for Occulta, live on ETH Sepolia — query registered agents, " +
    "their real Aave V3 positions, and reveal settled netting epochs via a real Nox gateway publicDecrypt.",
});

registerTools(server);
registerResources(server);

const transport = new StdioServerTransport();
await server.connect(transport);
