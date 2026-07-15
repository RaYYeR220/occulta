# occulta-mcp

An MCP server that hands an AI agent read access to Occulta's confidential DeFi strategy state,
live on ETH Sepolia. No mocks: every tool call is a real chain read against the deployed
contracts, and the marquee tool runs a real `publicDecrypt` against the live Nox gateway.

Occulta seals a strategist's trading policy and nets every depositor's intent inside a TEE before
revealing anything — the only value that ever crosses into plaintext is one aggregate order per
epoch. This server is that boundary, exposed as MCP tools: an agent can ask what's registered,
what actually happened on Aave, what a settled epoch's aggregate net was, and — critically —
verify for itself, live, that the individual intents behind that aggregate stay sealed.

## Tools

| Tool | What it does |
|---|---|
| `list_agents` | Iterates `StrategyRegistry.agentCount()` and returns every agent's PUBLIC metadata (id, name, mandate, strategist, runtime, active). The sealed policy itself is never returned — that opacity is the point. |
| `agent_status` | One agent's live state: `NetSettler.currentEpoch`, whether its latest epoch has settled, and its REAL Aave V3 position via `AaveAdapter.accountData()` / `healthFactor()` (collateral/debt in USD, health factor — `no debt` when Aave reports `type(uint256).max`). |
| `reveal_epoch_net` | The marquee tool. Runs a real `publicDecrypt` against the live Nox gateway for a settled epoch and returns the plaintext aggregate — e.g. `"30.00 USDC, BUY"` — with a note that this aggregate is the ONLY thing the epoch ever discloses. |
| `verify_confidentiality` | Demonstrates the privacy claim instead of asserting it: reads `NetSettler`'s live `buyTotal`/`sellTotal` ciphertexts (the closest on-chain artifact to an individual intent — no getter ever returns a raw intent handle), checks `isPubliclyDecryptable` (expect `false`), and attempts a REAL `publicDecrypt` against the gateway (expect rejection). Contrasts that against the epoch's aggregate, which IS publicly decryptable once closed. Returns a structured verdict, not a claim. |
| `live_proof` | The deployment: all 8 verified contract addresses with Etherscan links, the `settle()` transaction that netted 3 sealed intents into 30 USDC BUY and executed real Uniswap V3 + Aave V3 in one transaction, the resulting collateral delta, and a fresh live read of the agent's current Aave position. |

Two resources are also registered for clients that prefer reading over calling:

- `occulta://deployment` — the live deployment addresses and chain id.
- `occulta://agents` — the same live agent list as `list_agents`, as a resource.

## Run it

```bash
pnpm install
pnpm build
```

`pnpm build` compiles `src/` to `dist/index.js`. The server speaks MCP over stdio — it has no HTTP
port and nothing to "start" on its own; an MCP client spawns it as a subprocess.

## Add it to an MCP client

Any client that speaks MCP over stdio (Claude Desktop, Claude Code, or a custom agent harness)
can run this server with a snippet like:

```json
{
  "mcpServers": {
    "occulta": {
      "command": "node",
      "args": ["/absolute/path/to/occulta/mcp/dist/index.js"],
      "env": {
        "SEPOLIA_RPC_URL": "https://your-sepolia-rpc-url"
      }
    }
  }
}
```

Drop that under the `mcpServers` key of `claude_desktop_config.json` (or your client's equivalent
`mcp.json`), swap in the absolute path to this repo's `dist/index.js`, and restart the client.
`SEPOLIA_RPC_URL` is optional — omit it and the server falls back to a public Sepolia RPC.

## Configuration

Copy `.env.example` to `.env` if you want to pin your own RPC:

```
SEPOLIA_RPC_URL=
```

No private key, no secret, nothing to keep out of version control: every tool here only ever
reads chain state or runs a PUBLIC decrypt — a decrypt that is only possible in the first place
because `NetSettler.closeEpoch` already marked that specific handle publicly decryptable on-chain.
Nothing this server does could touch a sealed value even if it tried.

## Why this is safe to run against real infrastructure

- **Read-only wallet client.** The Nox handle client is built from a `viem` `WalletClient` with a
  transport but no `account` — `publicDecrypt` never signs anything, because the handle is already
  publicly decryptable on-chain by the time it's called.
- **No writes.** Every tool here is a `view` call or a gateway read. Nothing submits a transaction.
- **Live deployment addresses, not hand-copied ones.** Addresses are read from the sibling
  `../deployments/sepolia.json` at startup, with a literal fallback (the same live addresses) only
  for the case that file isn't present alongside the built package.

## Stack

TypeScript · `@modelcontextprotocol/sdk` (stdio transport) · `viem` for chain reads ·
`@iexec-nox/handle` for the real `publicDecrypt` against the live Nox gateway on Sepolia (chain
`11155111`, a network the SDK resolves out of the box — no gateway/subgraph override needed).
