# Building on iExec Nox — developer feedback

We built [Occulta](./README.md) — a confidential DeFi strategy-agent platform — on Nox over the
course of a few days, from a cold start to a live end-to-end run against real Sepolia. This is
candid feedback from that build: what worked, and the sharp edges we actually hit, with repro
steps and file/line references where we have them. Nothing here is theoretical — every issue
below is something our own contracts or tooling ran into and had to work around.

## What worked well

**The Hardhat plugin's local offchain stack.** `@iexec-nox/nox-hardhat-plugin` spins up the whole
KMS/gateway/runner/ingestor stack via Docker and injects `NoxCompute` into the simulated chain
with `hardhat_setCode`, so `pnpm hardhat test` gets real end-to-end confidential-compute testing —
encrypt, compute, decrypt, prove — without touching a testnet or paying gas. That let us build our
entire unit-test suite (47 tests) as fast, free, real TDD instead of mocking the confidential
layer out. This is genuinely excellent developer experience and the single biggest reason we could
iterate quickly.

**The `euint256` handle model, once it clicks.** `Nox.select` / `Nox.safeSub` give you exactly the
primitives you need to write branchless, no-leak logic — pick-a-or-b under an encrypted condition,
subtract without ever reverting on underflow. Our netting engine (`NetSettler._accumulate`) folds
every trading intent into two running totals with the *exact same* opcode sequence regardless of
which side the intent is on — no `if`, no early return, nothing an observer's gas trace or event
log could use to infer the encrypted side. Once you internalize "never branch on ciphertext, always
select," the model is natural to write correct confidential logic in.

**The ERC-7984 wrapper's unwrap path.** `ERC20ToERC7984Wrapper.unwrap` → `Nox.allowPublicDecryption`
on the burn amount → an off-chain `publicDecrypt` call that returns a proof → `finalizeUnwrap`
verifies that proof on-chain (`Nox.publicDecrypt`) before releasing the real ERC-20. That's a
clean, correct plaintext bridge: nobody can claim a payout without a gateway-signed proof over the
exact handle burned, and the pattern generalizes — we reused the identical proof-then-execute shape
for our own net-order reveal in `NetSettler.settle`.

**ERC-7984 + the confidential-vault references as a starting point.** The base ERC-7984 primitives
(`confidentialBalanceOf`, operators, the wrap/unwrap flow) and the confidential-4626/7540-shaped
vault reference we built from gave us a real EIP-7540 async request/approve/claim skeleton to adapt
to encrypted amounts, instead of designing that state machine from nothing. Good foundation.

## Sharp issues we hit

### 1. Fund-safety bug in the reference confidential ERC-7540 vault (productive-NAV double-count)

**What happened.** The vault reference we built our own vault from computes "productive NAV" —
the denominator every deposit/redeem is priced against — as `totalAssets - totalPendingDeposits`
only. It never excludes assets that are already reserved for an **approved-but-unclaimed redeem**.
`approveRedeem` burns the redeemer's shares immediately, but the matching assets stay sitting in
the vault's balance until the redeemer actually calls `redeem()` to claim them. In that window,
`totalAssets` still counts those assets, but `totalSupply` has already dropped — so NAV is
overstated for every settlement that happens in the same batch, before anyone claims.

**Why it matters, concretely.** With `totalAssets = 2e6` and two depositors holding `1e12` shares
each (`totalSupply = 2e12`), settling a full redeem for both in the same batch — the normal
operating pattern, not an attack — reserves the first `1e6` correctly, but then reserves the
**second redeemer 1,999,999** for shares actually worth `1,000,000`: the vault becomes insolvent
by roughly 50%. The accounting corruption is *unconditional* — it happens at `approveRedeem` time,
which moves no tokens, so nothing masks it. (In the *unmodified* reference, `redeem()`'s claim step
then reverts on its own via the `confidentialTransfer` ACL issue in §3 below, so the "second claimant
silently clamped to nothing" failure only surfaces once that transfer path is fixed — as it is in our
fork; the inflated-NAV corruption itself needs no such fix to be real.) Symmetrically, a depositor
who enters *after* an approved-but-unclaimed redeem is priced
against the reserved assets too and gets diluted — minting roughly half the fair share count for
the same input. Both reproduce with exact, predictable numbers; neither needs an adversary, only
the ordinary settle-a-batch-then-claim-later flow every async vault uses.

**Repro (numbers from our own reproduction against the reference logic):**
- *Insolvency*: `totalAssets = 2_000_000`, Alice and Bob each hold `1_000_000_000_000` shares. Agent
  approves Alice's full redeem (`assetsOut = 1_000_000`, `totalSupply → 1_000_000_000_000`), then
  approves Bob's full redeem in the same batch, before Alice claims. Bob's NAV is computed against
  the *unreduced* `2_000_000` balance and the halved supply, reserving him `1_999_999` instead of
  `1_000_000`.
- *Dilution*: with `1_000_000` already reserved for an approved-but-unclaimed redeem, a fresh
  depositor putting in `1_000_000` should mint `1_000_000_000_000` shares at par; the reference
  math mints roughly `500_000_249_999` instead — about half.

**Where.** In the reference `ConfidentialERC7540.sol`: the only inflight counter tracked is
`_totalPendingDepositAssets` (no equivalent counter exists for reserved-but-unclaimed redeems).
`approveDeposit` (line 283) and `approveRedeem` (line 342) both compute productive NAV with the
identical line —

```solidity
euint256 productiveAssets = Nox.sub(assetsBefore, _totalPendingDepositAssets);
```

— with no term excluding reserved redeem assets. This compounds with a second issue at line 421,
where `_claimableRedeemAssets[controller]` is zeroed *before* `_transferOut` runs; since the
transfer clamps silently to encrypted zero on a short balance (rather than reverting), a shortfall
caused by the NAV bug above permanently destroys the claim with no revert and no way to retry it.

**Our fix.** We ported this vault into our own codebase and fixed it there: a new
`_totalClaimableRedeemAssets` running counter, incremented at `approveRedeem` and decremented by
whatever `redeem()` actually manages to send out, subtracted out of the productive-NAV calculation
alongside the existing pending-deposit exclusion, plus reordering the transfer-then-residual logic
so a shortfall leaves a re-claimable residual instead of destroying the claim. We're flagging this
so it doesn't ship into someone's mainnet fork as-is — happy to share our patched version or the
two failing/passing test cases if useful.

### 2. `Nox.toEuint256()` returns a PUBLIC handle

This one is an easy, silent footgun for the "hidden balance" mental model. `Nox.toEuint256(value)`
wraps a plaintext constant as a *public* handle (`wrapAsPublicHandle` under the hood) — it is not
a secret, and Nox knows it isn't. Two consequences that surprised us:

- Calling `Nox.allowPublicDecryption()` on a handle produced by `toEuint256` reverts with
  `PublicHandleACLForbidden()` — public handles are already implicitly decryptable by everyone, so
  the ACL module refuses the redundant mutation.
- More importantly: **a real secret must always enter a contract via `Nox.fromExternal`** (bound
  to an encryption proof), never via `Nox.toEuint256`. It's tempting to reach for `toEuint256` when
  seeding a zero or a constant inside contract logic — which is fine, it's the correct tool there —
  but it's an easy mistake to reach for the same function when you actually meant to seal a value,
  and the failure mode is "the value was never confidential in the first place," not a helpful
  revert at the point of the mistake. The docs already carry a good "this value is public, by design"
  warning on the `wrapAsPublicHandle` page — what would round it out is a one-line cross-reference to
  the concrete `PublicHandleACLForbidden()` revert you hit if you later try to `allowPublicDecryption`
  such a handle, so the two behaviors are connected in one place.

### 3. `confidentialTransfer` vs `confidentialTransferFrom` ACL asymmetry

`ERC7984Base.confidentialTransferFrom` grants its caller transient Nox ACL on the returned
`transferred` handle (`Nox.allowTransient(transferred, msg.sender)`); the plain
`confidentialTransfer` does not. If you write vault code that does a plain
`confidentialTransfer(to, amount)` and then tries `Nox.allow(sent, to)` on the result — a pattern
that looks completely natural coming from the "From" variant — it reverts `UnauthorizedSender`,
because the caller was never granted transient access to the handle it's now trying to re-grant.

We hit this in our vault's `_transferOut` (moving funds from the vault to a depositor) and had to
route it through `confidentialTransferFrom(address(this), to, amount)` instead — which works
because `isOperator(holder, spender)` is trivially true when the vault is both holder and spender,
and the "From" variant grants the transient ACL we need. Either align the two entry points'
ACL behavior, or call out the difference loudly in the docs — right now it's the kind of thing you
only discover by hitting the revert.

### 4. Hardhat plugin's Docker stack fails to start on Windows (current `main`, unreleased)

`docker-compose` (the npm package the plugin uses to drive `docker compose`) is spawned with an
`env` option that **replaces** the parent process's environment rather than merging into it. On
Windows, that means the Docker CLI loses `PATH`, `SystemRoot`, `USERPROFILE`, and `APPDATA`, and
can no longer resolve its own context or named pipe — `startOffchainServices()` fails outright.

The failure is also swallowed unhelpfully: the catch handler does `String(error)` on whatever
`docker-compose` threw, which for that library is typically a plain `{ err, out }` object — so the
actual stderr never surfaces and you just see `[nox] Failed to start the offchain stack:
[object Object]`.

We patched both locally to get the local stack running at all on Windows:
- merge `{ ...process.env, ...COMPOSE_OPTS.env }` into every `docker-compose` call
  (`upAll`/`downAll`/`port`/`logs`) instead of passing `COMPOSE_OPTS.env` alone
- surface the real error payload instead of `String(error)` in the catch handler

Patch is a couple of lines in `dist/src/utils/offchain-services.js`; happy to upstream it as a PR
if that's useful rather than everyone patching their own `node_modules`.

### 5. No persistent ACL revoke

`ACL.sol` exposes `allow`, `allowTransient`, `disallowTransient`, `addViewer`, and
`allowPublicDecryption` — but there is no persistent `disallow`. Once an address has been granted
`allow(handle, account)`, that grant lives forever; only *transient* (single-transaction) access
can be revoked.

This makes any runtime-key-rotation story additive-only. In `StrategyRegistry.setRuntime`, handing
a strategy's policy to a new runtime means granting the new address decrypt rights on every policy
slot — but the *old* runtime keeps its existing grants, because there's nothing to call to strip
them. For a product where "rotate the operator key because it might be compromised" is a real
operational need, that's a meaningful limitation: the rotated-out key can still read everything it
was ever granted, forever. A persistent `disallow(handle, account)` (even if gas-costlier or more
restrictive than `allow`) would close a real gap for anyone building key-rotation into their
operational model.

### 6. Transient gateway 403 on first read after a grant

A handful of times during our live Sepolia run, a decrypt/`publicDecrypt` call made immediately
after the transaction that granted access landed with a `403 {"error":"rpc","message":"RPC error:
Access denied: not a viewer"}` — and then succeeded on an immediate retry a few seconds later. Both
occurrences were reads that followed an ACL grant or a public-decryption mark in the
*immediately preceding* confirmed transaction, so this reads as an indexing lag in the gateway
rather than an actual permission problem. It never took more than one retry in our run, but it's
worth documenting the eventual-consistency window explicitly (and/or having the SDK auto-retry
once on that specific error) so it doesn't read as a bug to someone hitting it for the first time.

---

None of this is a complaint about the direction — the TEE-backed local stack, the handle model,
and the wrap/unwrap bridge are a genuinely strong foundation, and we shipped a real confidential
DeFi flow against real Sepolia on top of them in a few days. This is the feedback we'd want if we
were on the other side of it.
