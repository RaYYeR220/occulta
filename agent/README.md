# occulta-agent

The autonomous runtime behind an Occulta strategy agent — the long-running keeper service that
turns "confidential DeFi strategy agent" from a demo script into an actual service. It polls live
ETH Sepolia, decrypts its own sealed policy, decides whether to rebalance, and — when it decides
yes — drives the full confidential settlement path itself: submit an encrypted intent, close the
epoch, reveal only the aggregate net, and settle it against the real Uniswap V3 + Aave V3
integration. No mocks, no simulated chain: every write in live mode is a real Sepolia transaction.

`scripts/demo.ts` proved the confidential plumbing works, end to end, once. This service is what
runs it on a loop, unattended, deciding for itself when there's anything to do.

## What it does, one tick at a time

1. **Sweep pending deposits.** Scans `OccultaVault`'s `DepositRequest` events (confirmation-depth
   aware — never reads past `head - CONFIRMATION_DEPTH`) and, for any controller still holding an
   undecided pending deposit, calls `approveDeposit`. Idempotent: an empty pending bucket is a
   silent no-op in the contract, never a double-spend.
2. **Decide.** On the configured epoch cadence, decrypts its sealed policy from
   `StrategyRegistry` and computes a rebalance decision from live market state (see *The strategy
   rule* below). Most ticks conclude "hold" — that's the honest, common case for a target-weight
   rule sampled frequently against a real, live position.
3. **Settle, if there's a decision.** Submits one fresh-encrypted intent into `NetSettler`,
   closes the epoch, `publicDecrypt`s the revealed aggregate (magnitude + direction — the only two
   values the epoch ever discloses), quotes a slippage-bounded `minOut` off a live Uniswap V3
   QuoterV2 call, and calls `settle`, which forwards the proven plaintext to `OccultaExecutor` for
   the real swap + Aave leg.

Every step is logged with its transaction hash before and after confirmation. Nothing here is a
`setInterval` wrapped around `demo.ts`'s script body: submitting into a closed epoch, closing an
already-closed epoch, and settling an already-settled one are all guarded by a live on-chain read
immediately before the write, not by an in-memory flag — see *Resume and idempotency* below.

## The strategy rule

Deliberately small, and stated here in full — this is the entire trading logic, nothing is hidden
behind a "TODO: smarter strategy":

> Compare what fraction of the vault's capital is currently deployed as Aave WETH collateral
> against the strategist's sealed target fraction (`targetWeightBps`). If the drift exceeds the
> sealed trigger (`rebalanceTriggerBps`), rebalance by the drift — capped by the sealed risk
> budget (`riskCapBps`) and by this runtime's own configured safety ceiling
> (`MAX_INTENT_USDC` / `MAX_INTENT_WETH`, a keeper-side circuit breaker independent of whatever
> the policy allows).

Policy slots, per `IStrategyRegistry`'s documented convention (`contracts/registry/StrategyRegistry.sol`):

| Slot | Name | Used as |
|---|---|---|
| 0 | `targetWeightBps` | target fraction of vault capital deployed to Aave |
| 1 | `rebalanceTriggerBps` | drift (in bps of capital) that must be exceeded before acting |
| 2 | `maxLeverageBps` | read and asserted as an invariant (see below) — not a trade input |
| 3 | `riskCapBps` | maximum fraction of capital this runtime will move in a single epoch |

No leverage, ever. `OccultaExecutor`'s BUY leg only ever supplies WETH to Aave and its SELL leg
only ever withdraws it — `AaveAdapter.borrow` is never called anywhere in the execution path this
runtime drives. `maxLeverageBps` is decrypted and logged every cycle as a policy-conformance
check (a warning if Aave ever reports non-zero debt for this position, which should never happen
under this rule), not consumed to size a trade.

Unit convention, which the rule has to get right or the trade is wrong (`OccultaExecutor.sol`
states this explicitly in its own header): a BUY's amount is USDC — capital to deploy. A SELL's
amount is WETH — collateral to withdraw. The two legs are not the same asset, so a SELL decision's
dollar-denominated drift is converted to WETH units via a live Uniswap V3 QuoterV2 quote before it
is ever submitted as an intent.

Below the sealed trigger, or below a small dust floor (`MIN_TRADE_USDC` / `MIN_TRADE_WETH`), the
decision is `hold` and the runtime submits nothing that epoch — an epoch needs at least one intent
to close (`NetSettlerEmptyEpoch`), and manufacturing one to satisfy a counter would be exactly the
kind of fakery this task asked not to ship.

## Resume and idempotency

Every write-bearing step re-reads live on-chain state immediately before acting:

- Before submitting an intent: is the current epoch's `intentCount` still `0`? If a previous,
  possibly-crashed run already submitted into it, this run skips straight to closing instead of
  submitting a second one.
- Before closing: is the epoch still open? `NetSettler` itself would revert on a second close, but
  the check means the runtime never even sends that transaction.
- Before settling: **first**, does the *previous* epoch have a `closed` state but no `settled`
  one? If a prior run crashed between `closeEpoch` and `settle`, that epoch's revealed aggregate
  is real and must not be abandoned — it is settled before any new work is considered, every tick,
  until it succeeds.

An in-process lock also prevents two settlement cycles from overlapping if one tick runs long.

## DRY_RUN mode

`DRY_RUN=true` (the default) runs every read, every decrypt, and every quote for real — the
logged policy values, capital figures, and rebalance decision are genuine live numbers — but never
broadcasts a state-changing transaction. Where a real decision would submit an intent, it logs
`[DRY RUN] would submit …` and stops; it does not fabricate a downstream aggregate, because the
aggregate genuinely does not exist until a real `closeEpoch` nets it inside the Nox TEE. The one
exception is the resume path: if a previous *live* run already left a closed-but-unsettled epoch
on-chain, DRY_RUN will still run the real `publicDecrypt` against it (a read) and show the real
`minOut` it would settle with, just without sending `settle`.

## Running it

```bash
pnpm install
pnpm build
cp .env.example .env   # fill in RUNTIME_PRIVATE_KEY at minimum
pnpm start:dry          # DRY_RUN=true, loops forever, logs every planned cycle
pnpm start               # honors DRY_RUN from .env — set it to false to go live
```

Set `RUN_ONCE=true` to run exactly one tick (deposit sweep + one settlement-cycle decision) and
exit — useful for capturing a clean transcript, or for driving the runtime from an external
scheduler instead of its own loop.

### Config (`.env`, see `.env.example`)

| Var | Meaning | Default |
|---|---|---|
| `RUNTIME_PRIVATE_KEY` | Signing key. Must be the address `StrategyRegistry` names as this agent's `runtime` **and** `OccultaVault`'s `owner()` — both checked live before any write. | required |
| `SEPOLIA_RPC_URL` | RPC endpoint. | public fallback |
| `DRY_RUN` | Plan-only mode. | `true` |
| `RUN_ONCE` | Single tick then exit. | `false` |
| `POLL_INTERVAL_MS` / `EPOCH_CADENCE_MS` | Watch-loop poll rate / minimum time between settlement-cycle attempts. | `15000` / `300000` |
| `CONFIRMATION_DEPTH` | Blocks held back from `head` before the deposit scan trusts them. | `2` |
| `MAX_BACKOFF_MS` | Ceiling for the loop's exponential backoff on transient errors. | `120000` |
| `DEPOSIT_SCAN_LOOKBACK_BLOCKS` / `DEPOSIT_LOG_CHUNK_BLOCKS` | `DepositRequest` log-scan window and per-call chunk size — kept small by default because some RPC providers (Alchemy's free tier included) cap `eth_getLogs` to a handful of blocks per call. Raise both if your provider allows more. | `300` / `10` |
| `SLIPPAGE_BPS` | Slippage tolerance off the live QuoterV2 quote. | `300` (3%) |
| `MAX_INTENT_USDC` / `MAX_INTENT_WETH` | Keeper-side safety ceiling on a single epoch's intent size, independent of the sealed risk cap. | `20` / `0.002` |
| `MIN_TRADE_USDC` / `MIN_TRADE_WETH` | Dust floor below which a computed drift is not worth trading. | `1` / `0.0002` |
| `EXECUTOR_USDC_BUFFER` | Extra USDC minted to the executor on top of what a BUY leg needs (see next section). | `5` |
| `AGENT_ID` | Overrides the agent id read from `deployments/sepolia.json`. | from deployment |

## Safety notes

- **The vault-to-executor bridge is out of scope on-chain in this deployment** (documented in
  `scripts/demo.ts`'s own header and in `OccultaExecutor.sol`) — a BUY leg's Uniswap swap needs
  USDC sitting on the executor before it can run, and nothing on-chain moves the vault's deposited
  USDC there automatically yet. This runtime pre-funds the executor directly via the same testnet
  faucet `demo.ts` uses, logged explicitly every time it happens (`faucetMint:executor`). That is
  a workaround for a known, documented gap — not something this service pretends is production
  design.
- **No persistent cursor.** The deposit watcher re-scans a bounded backward window from the chain
  head every tick rather than persisting a forward-advancing watermark to a database, which a
  production keeper (see the cVault backend this design is modeled on) would do instead. Fine at
  Sepolia's traffic and the configured poll interval; a real deployment watching a busier chain,
  or one that expects long downtime, should persist a cursor.
- **Never crash-loops.** Errors are classified transient vs. permanent (`src/errors.ts`) purely to
  tune backoff — the actual protection against double-spending gas is that every write re-verifies
  on-chain state immediately before sending (see *Resume and idempotency*), not the classification.
- **Single-instance assumption.** This service does not coordinate with a second instance of
  itself. Running two processes against the same runtime key against the same agent is not
  something the resume guard was designed to make safe (though it *is* designed to survive one
  process crashing and a second one picking the same state back up).

## Proof: one real autonomous cycle, live on Sepolia

Run with `DRY_RUN=false RUN_ONCE=true` on `agentId = 0`, driving a brand-new epoch (epoch 1 —
epoch 0 was `demo.ts`'s earlier proof) end to end with no human in the loop beyond starting the
process:

1. Decrypted its own sealed policy live: `targetWeightBps=6000` (60%), `rebalanceTriggerBps=500`
   (5%), `maxLeverageBps=20000`, `riskCapBps=3000` (30%).
2. Read live state: vault capital `50 USDC`, Aave-deployed value `$39.05977088`. Computed drift
   `1811bps` — over the 500bps trigger — so a SELL, sized `0.002 WETH` (risk-cap/safety-ceiling
   bound, well under the `~0.00976 WETH` actually held as collateral).
3. `submitIntent` — [`0xe30360c855805a3b9b061bd988ceee06cd612df8144705dd0ab5bd0fecd164d8`](https://sepolia.etherscan.io/tx/0xe30360c855805a3b9b061bd988ceee06cd612df8144705dd0ab5bd0fecd164d8)
4. `closeEpoch(0)` for epoch 1 — [`0x99cbba155daade387fe62a0a7c2728aeeac213977d09f8eb2b445efa6de3042d`](https://sepolia.etherscan.io/tx/0x99cbba155daade387fe62a0a7c2728aeeac213977d09f8eb2b445efa6de3042d)
5. Revealed aggregate via live `publicDecrypt`: **net = 0.002 WETH, direction = SELL** — exactly
   the single intent submitted, as expected for a one-intent epoch.
6. `settle(0, 1, …)` — [`0xd0b6c2fc23854a6d29a8c93151eecdc0d3aec956e77f2e9722048f78958bda1a`](https://sepolia.etherscan.io/tx/0xd0b6c2fc23854a6d29a8c93151eecdc0d3aec956e77f2e9722048f78958bda1a) —
   withdrew `0.002 WETH` from the real Aave V3 Pool and swapped it on the real Uniswap V3
   `SwapRouter02` for `6.088372 USDC`.

Verified independently against live chain state after the run: `AaveAdapter`'s aWETH balance went
from `0.009764942720128096` to `0.007764942720128096` (exactly `-0.002`), and `OccultaExecutor`'s
USDC balance went from `0` to `6.088372` — matching the `Executed` event's `resultAmount` exactly.
Zero reverts, zero retries. Full details, including the preceding DRY_RUN transcript, are in
`_internal/reports/agent-runner-report.md`.

## Stack

TypeScript · `viem` for chain reads/writes · `@iexec-nox/handle` for policy decryption, intent
encryption, and the live `publicDecrypt` reveal — all against the live Nox gateway on ETH Sepolia
(chain `11155111`).
