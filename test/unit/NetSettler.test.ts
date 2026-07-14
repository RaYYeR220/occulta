import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { nox, NOX_COMPUTE_ADDRESS } from "@iexec-nox/nox-hardhat-plugin";
import { parseAbi, parseEventLogs } from "viem";

/** Amounts are denominated in the 6-decimal USDC scale the rest of the stack uses. */
const USDC = 1_000_000n;

const CONTRACT_URI = "https://occulta.example/ocusdc.json";
const ZERO_HANDLE = `0x${"00".repeat(32)}` as const;

/**
 * Minimal ABI slice of the deployed NoxCompute proxy. `allow` hands a settler-bound handle the
 * Nox ACL grant it needs before the settler can fold it into an epoch. `Select` is read back out
 * of a submission's receipt to get at the per-intent contribution handles the settler never
 * exposes itself — an observer's most natural next move once the side is sealed, and one the
 * privacy tests below have to close.
 */
const noxComputeAbi = parseAbi([
  "function allow(bytes32 handle, address account) external",
  "event Select(address indexed caller, bytes32 condition, bytes32 ifTrue, bytes32 ifFalse, bytes32 result)",
]);

/** Flattens an error and its `cause` chain into one searchable string. */
function flattenError(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  for (let depth = 0; current != null && depth < 6; depth++) {
    const e = current as {
      shortMessage?: string;
      details?: string;
      message?: string;
      metaMessages?: string[];
      cause?: unknown;
    };
    if (e.shortMessage) parts.push(e.shortMessage);
    if (e.details) parts.push(e.details);
    if (e.metaMessages) parts.push(e.metaMessages.join(" "));
    if (e.message) parts.push(e.message);
    current = e.cause;
  }
  return parts.join(" | ");
}

/** Asserts that `promise` rejects with a revert whose message mentions `errorName`. */
async function assertRevertsWithError(promise: Promise<unknown>, errorName: string) {
  await assert.rejects(promise, (error: unknown) => {
    const message = flattenError(error);
    assert.ok(
      message.includes(errorName),
      `expected revert mentioning "${errorName}", got: ${message}`,
    );
    return true;
  });
}

/**
 * Asserts the decryption gateway REFUSES to open `handle` for the public — not that the value is
 * merely unadvertised. This is the assertion the whole design rests on, so it is made explicitly
 * (`false` / a refusal), never assumed.
 */
async function assertNotPubliclyDecryptable(handle: `0x${string}`, what: string) {
  await assert.rejects(nox.publicDecrypt(handle), (error: unknown) => {
    const message = flattenError(error);
    assert.ok(
      message.includes("not publicly decryptable"),
      `expected a public-decryption refusal for ${what}, got: ${message}`,
    );
    return true;
  });
}

/**
 * The two errors NoxCompute can raise while validating a public-decryption proof. They are
 * declared in NoxCompute, not in NetSettler, so viem surfaces them as raw selectors rather than
 * decoded names — hence the constants.
 *
 * `InvalidProof(bytes proof, string reason)`: the proof parsed, but the signature recovered from
 * it is not the decryption gateway's ("Invalid signature"), or it is too short to parse at all
 * ("Proof too short").
 * `ECDSAInvalidSignatureS(bytes32)`: OpenZeppelin's ECDSA library refusing a malformed `s` while
 * recovering — the same code path, one layer down.
 */
const INVALID_PROOF = "0xae385f38";
const ECDSA_INVALID_S = "0xd78bce0c";
/** ASCII "Invalid signature", as it appears in the ABI-encoded `reason` of `InvalidProof`. */
const REASON_INVALID_SIGNATURE = "496e76616c6964207369676e6174757265";

/**
 * Asserts that `promise` reverted INSIDE NoxCompute's decryption-proof validation — not merely
 * that it reverted. Without pinning the failure to the proof check, a forged-proof test could
 * pass for a completely unrelated reason (a closed epoch, a rejected caller) and would prove
 * nothing at all about whether the contract trusts off-chain plaintexts.
 */
async function assertRejectedByProofCheck(
  promise: Promise<unknown>,
  what: string,
  expectBadSignature = true,
) {
  await assert.rejects(promise, (error: unknown) => {
    const message = flattenError(error);
    assert.ok(
      message.includes(INVALID_PROOF) || message.includes(ECDSA_INVALID_S),
      `${what}: expected NoxCompute to reject the proof, got: ${message}`,
    );
    if (expectBadSignature) {
      assert.ok(
        message.includes(REASON_INVALID_SIGNATURE),
        `${what}: expected the gateway signature check to fail, got: ${message}`,
      );
    }
    return true;
  });
}

type Viem = Awaited<ReturnType<typeof nox.connect>>["viem"];
type Wallet = Awaited<ReturnType<Viem["getWalletClients"]>>[number];

/**
 * Deploys registry + mock executor + settler, and registers one agent whose runtime is
 * `runtime`.
 *
 * The runtime MUST be `viem.getWalletClients()[0]`: `nox.encryptInput` binds the input proof's
 * `owner` field to the connection's first signer, and `Nox.fromExternal` requires the settler's
 * `msg.sender` to equal that owner. Since only the registered runtime may submit an intent, the
 * two constraints collapse into one — account 0 plays the runtime everywhere. It also plays the
 * strategist, for the same reason (registering seals a policy through `nox.encryptInput`).
 */
async function deployStack(viem: Viem, runtime: Wallet) {
  const registry = await viem.deployContract("StrategyRegistry");
  const executor = await viem.deployContract("MockExecutionTarget");
  const settler = await viem.deployContract("NetSettler", [registry.address, executor.address]);

  const agentId = await registerAgent(registry, runtime);
  return { registry, executor, settler, agentId };
}

type Registry = Awaited<ReturnType<typeof deployStack>>["registry"];
type Settler = Awaited<ReturnType<typeof deployStack>>["settler"];

/** Registers an agent with a sealed 4-slot policy; returns its agentId. */
async function registerAgent(registry: Registry, runtime: Wallet): Promise<bigint> {
  const handles: `0x${string}`[] = [];
  const proofs: `0x${string}`[] = [];
  for (const value of [6000n, 500n, 20000n, 3000n]) {
    const { handle, handleProof } = await nox.encryptInput(value, "uint256", registry.address);
    handles.push(handle);
    proofs.push(handleProof);
  }

  const agentId = (await registry.read.agentCount()) as bigint;
  await registry.write.registerAgent(
    ["Occulta Agent", "Confidential net-flow rebalancer", runtime.account.address, handles, proofs],
    { account: runtime.account },
  );
  return agentId;
}

/** The two sealed halves of one intent, plus the transaction that filed it. */
interface Intent {
  /** Handle of the encrypted size. */
  amount: `0x${string}`;
  /** Handle of the encrypted SIDE. Never a plaintext bool, anywhere. */
  side: `0x${string}`;
  hash: `0x${string}`;
}

/**
 * Submits one depositor's encrypted intent through the runtime and returns the handles the
 * settler now holds for it. BOTH halves of an intent are sealed: `Nox.fromExternal` wraps the
 * very same bytes32 the gateway minted here, for the size and for the side alike, so the handles
 * returned are exactly the ones accumulated on-chain — which is what makes the privacy assertions
 * below meaningful rather than decorative.
 */
async function submitIntent(
  settler: Settler,
  runtime: Wallet,
  agentId: bigint,
  amount: bigint,
  isBuy: boolean,
): Promise<Intent> {
  const size = await nox.encryptInput(amount, "uint256", settler.address);
  const side = await nox.encryptInput(isBuy, "bool", settler.address);
  const hash = await settler.write.submitIntent(
    [agentId, size.handle, size.handleProof, side.handle, side.handleProof],
    { account: runtime.account },
  );
  return { amount: size.handle, side: side.handle, hash };
}

/** Closes the epoch and returns the (magnitude, direction) handle pair it revealed. */
async function closeEpoch(settler: Settler, runtime: Wallet, agentId: bigint, epoch: bigint) {
  await settler.write.closeEpoch([agentId], { account: runtime.account });
  const net = (await settler.read.netOf([agentId, epoch])) as `0x${string}`;
  const direction = (await settler.read.netDirectionOf([agentId, epoch])) as `0x${string}`;
  return { net, direction };
}

/** Publicly decrypts the aggregate pair and hands back both plaintexts and both proofs. */
async function revealNet(net: `0x${string}`, direction: `0x${string}`) {
  const { value: netPlaintext, decryptionProof: netProof } = await nox.publicDecrypt(net);
  const { value: netIsBuy, decryptionProof: directionProof } = await nox.publicDecrypt(direction);
  return {
    netPlaintext: netPlaintext as bigint,
    netIsBuy: netIsBuy as boolean,
    netProof,
    directionProof,
  };
}

describe("NetSettler", () => {
  it(
    "nets three depositors' intents and reveals only the aggregate order",
    { timeout: 300_000 },
    async () => {
      const { viem } = await nox.connect();
      const publicClient = await viem.getPublicClient();
      const [runtime] = await viem.getWalletClients();
      const { settler, executor, agentId } = await deployStack(viem, runtime);

      assert.equal(await settler.read.currentEpoch([agentId]), 0n);

      // Three different depositors, mixed directions: +100, +250, -50 => net +300 (buy).
      // Every one of them is folded into BOTH totals under its encrypted side, so the sum below
      // is the same sum the plaintext-side version produced.
      const alice = await submitIntent(settler, runtime, agentId, 100n * USDC, true);
      const bob = await submitIntent(settler, runtime, agentId, 250n * USDC, true);
      const carol = await submitIntent(settler, runtime, agentId, 50n * USDC, false);

      const [intentCount, closedBefore, settledBefore] = (await settler.read.epochStateOf([
        agentId,
        0n,
      ])) as [bigint, boolean, boolean];
      assert.equal(intentCount, 3n);
      assert.equal(closedBefore, false);
      assert.equal(settledBefore, false);

      const { net, direction } = await closeEpoch(settler, runtime, agentId, 0n);
      assert.equal(await settler.read.currentEpoch([agentId]), 1n, "closing advances the epoch");

      const { netPlaintext, netIsBuy, netProof, directionProof } = await revealNet(net, direction);
      assert.equal(netPlaintext, 300n * USDC, "the revealed net is 100 + 250 - 50 = 300");
      assert.equal(netIsBuy, true, "buys dominate, so the aggregate order is a buy");

      // Nothing but the aggregate ever became public — not a size, not a side.
      for (const [who, intent] of [
        ["alice", alice],
        ["bob", bob],
        ["carol", carol],
      ] as const) {
        assert.equal(
          await settler.read.isPubliclyDecryptable([intent.amount]),
          false,
          `${who}'s individual intent size must never be publicly decryptable`,
        );
        assert.equal(
          await settler.read.isPubliclyDecryptable([intent.side]),
          false,
          `${who}'s individual intent side must never be publicly decryptable`,
        );
      }
      assert.equal(await settler.read.isPubliclyDecryptable([net]), true);
      assert.equal(await settler.read.isPubliclyDecryptable([direction]), true);

      const minOut = 299n * USDC;
      const hash = await settler.write.settle([agentId, 0n, netProof, directionProof, minOut], {
        account: runtime.account,
      });
      const receipt = await publicClient.waitForTransactionReceipt({ hash });

      const settled = await settler.getEvents.Settled(
        {},
        { fromBlock: receipt.blockNumber, toBlock: receipt.blockNumber },
      );
      assert.equal(settled.length, 1);
      assert.equal(settled[0].args.netPlaintext, 300n * USDC);
      assert.equal(settled[0].args.netIsBuy, true);
      assert.equal(settled[0].args.epoch, 0n);

      // The verified plaintext net is what gets forwarded to the execution adapter
      // (the real Aave/Uniswap target lands in Tasks 7-8; this is the mock target).
      assert.equal(await executor.read.callCount(), 1n);
      assert.equal(await executor.read.lastNetAmount(), 300n * USDC);
      assert.equal(await executor.read.lastNetIsBuy(), true);
      assert.equal(await executor.read.lastMinOut(), minOut);
      assert.equal(await executor.read.lastAgentId(), agentId);
      assert.equal(await executor.read.lastEpoch(), 0n);
      assert.equal(
        (await executor.read.lastCaller() as string).toLowerCase(),
        settler.address.toLowerCase(),
      );

      const [, closedAfter, settledAfter] = (await settler.read.epochStateOf([agentId, 0n])) as [
        bigint,
        boolean,
        boolean,
      ];
      assert.equal(closedAfter, true);
      assert.equal(settledAfter, true);
    },
  );

  it(
    "privacy: an individual intent is neither publicly decryptable nor readable by an outsider",
    { timeout: 300_000 },
    async () => {
      const { viem } = await nox.connect();
      const [runtime, outsider] = await viem.getWalletClients();
      const { settler, agentId } = await deployStack(viem, runtime);

      const alice = await submitIntent(settler, runtime, agentId, 100n * USDC, true);
      const bob = await submitIntent(settler, runtime, agentId, 250n * USDC, true);
      const carol = await submitIntent(settler, runtime, agentId, 50n * USDC, false);
      const intents = { alice, bob, carol };

      const buyTotal = (await settler.read.buyTotalOf([agentId, 0n])) as `0x${string}`;
      const sellTotal = (await settler.read.sellTotalOf([agentId, 0n])) as `0x${string}`;

      const { net, direction } = await closeEpoch(settler, runtime, agentId, 0n);

      for (const [who, intent] of Object.entries(intents)) {
        // (a) The contract never marked it publicly decryptable...
        assert.equal(
          await settler.read.isPubliclyDecryptable([intent.amount]),
          false,
          `${who}'s intent must not be publicly decryptable`,
        );
        // (b) ...an outsider holds no ACL grant on it...
        assert.equal(
          await settler.read.isAllowedFor([intent.amount, outsider.account.address]),
          false,
          `an outsider must not be allowed on ${who}'s intent`,
        );
        // (c) ...and the settler itself plus the runtime are the ONLY parties that are.
        assert.equal(
          await settler.read.isAllowedFor([intent.amount, settler.address]),
          true,
          `the settler must keep ACL on ${who}'s intent to accumulate it`,
        );
        assert.equal(
          await settler.read.isAllowedFor([intent.amount, runtime.account.address]),
          true,
          `the runtime must keep ACL on ${who}'s intent`,
        );
        // (d) A public decryption attempt genuinely fails, it is not merely unadvertised.
        await assertNotPubliclyDecryptable(intent.amount, `${who}'s intent`);
      }

      // The running sub-totals are components of the aggregate, not the aggregate: they stay
      // sealed too. Only their netted difference is ever opened.
      for (const [name, handle] of [
        ["buyTotal", buyTotal],
        ["sellTotal", sellTotal],
      ] as const) {
        assert.equal(
          await settler.read.isPubliclyDecryptable([handle]),
          false,
          `${name} must never be publicly decryptable`,
        );
        assert.equal(
          await settler.read.isAllowedFor([handle, outsider.account.address]),
          false,
          `an outsider must not be allowed on ${name}`,
        );
        await assert.rejects(nox.publicDecrypt(handle));
      }

      // ...while the aggregate net order IS public — that is the whole point.
      const { netPlaintext, netIsBuy } = await revealNet(net, direction);
      assert.equal(netPlaintext, 300n * USDC);
      assert.equal(netIsBuy, true);
    },
  );

  it(
    "privacy: an individual intent's SIDE is sealed — not publicly decryptable, not readable by an outsider",
    { timeout: 300_000 },
    async () => {
      const { viem } = await nox.connect();
      const publicClient = await viem.getPublicClient();
      const [runtime, outsider] = await viem.getWalletClients();
      const { settler, agentId } = await deployStack(viem, runtime);

      // Two buys and a sell. If the side leaked, THIS is what it would betray: that carol sold
      // while alice and bob bought — and an intent handle can be a pre-existing on-chain
      // ciphertext (a depositor's `confidentialBalanceOf`), so a leaked side is not abstract,
      // it is attributable to a named address.
      const alice = await submitIntent(settler, runtime, agentId, 100n * USDC, true);
      const bob = await submitIntent(settler, runtime, agentId, 250n * USDC, true);
      const carol = await submitIntent(settler, runtime, agentId, 50n * USDC, false);
      const intents = { alice, bob, carol };

      // The side never appears as a plaintext anywhere in the transaction: the event carries a
      // 32-byte handle, exactly like the size does.
      const submitReceipt = await publicClient.waitForTransactionReceipt({ hash: carol.hash });
      const events = await settler.getEvents.IntentSubmitted(
        {},
        { fromBlock: submitReceipt.blockNumber, toBlock: submitReceipt.blockNumber },
      );
      assert.equal(events.length, 1);
      assert.equal(events[0].args.isBuy, carol.side, "the event emits the side HANDLE, not a bool");
      assert.equal(events[0].args.amount, carol.amount);
      assert.notEqual(
        typeof events[0].args.isBuy,
        "boolean",
        "no plaintext side may survive anywhere in the event",
      );

      for (const [who, intent] of Object.entries(intents)) {
        // (a) The side was never marked publicly decryptable...
        assert.equal(
          await settler.read.isPubliclyDecryptable([intent.side]),
          false,
          `${who}'s intent side must not be publicly decryptable`,
        );
        // (b) ...the gateway genuinely refuses to open it for the public...
        await assertNotPubliclyDecryptable(intent.side, `${who}'s intent side`);
        // (c) ...an outsider holds no ACL grant on it, so they cannot decrypt it either...
        assert.equal(
          await settler.read.isAllowedFor([intent.side, outsider.account.address]),
          false,
          `an outsider must not be allowed on ${who}'s intent side`,
        );
        // (d) ...and the settler plus the runtime are the only parties that are.
        assert.equal(
          await settler.read.isAllowedFor([intent.side, settler.address]),
          true,
          `the settler must keep ACL on ${who}'s side to fold it into both totals`,
        );
        assert.equal(
          await settler.read.isAllowedFor([intent.side, runtime.account.address]),
          true,
          `the runtime must keep ACL on ${who}'s side`,
        );
      }

      // Two identical sides do not share a handle: the side ciphertext is not a deterministic
      // function of the bit, so an outsider cannot encrypt `true` themselves and match handles.
      assert.notEqual(alice.side, bob.side, "two buys must not collide on one side handle");

      // The obvious next move for an observer: the settler never exposes the per-intent
      // contributions, but NoxCompute's `Select` events do. Those handles are sealed as well —
      // `select(isBuy, amount, 0)` is worth exactly as much as `isBuy` if you can open it.
      const contributions = parseEventLogs({
        abi: noxComputeAbi,
        eventName: "Select",
        logs: submitReceipt.logs,
      }).map((log) => log.args.result as `0x${string}`);
      assert.equal(contributions.length, 2, "each intent folds into BOTH totals, buy and sell");
      for (const [i, contribution] of contributions.entries()) {
        assert.equal(
          await settler.read.isPubliclyDecryptable([contribution]),
          false,
          `contribution ${i} must not be publicly decryptable`,
        );
        assert.equal(
          await settler.read.isAllowedFor([contribution, outsider.account.address]),
          false,
          `an outsider must not be allowed on contribution ${i}`,
        );
        await assertNotPubliclyDecryptable(contribution, `contribution ${i}`);
      }

      // And the netting still works, with the sides sealed: 100 + 250 - 50 = 300, a buy.
      const { net, direction } = await closeEpoch(settler, runtime, agentId, 0n);
      const { netPlaintext, netIsBuy } = await revealNet(net, direction);
      assert.equal(netPlaintext, 300n * USDC);
      assert.equal(netIsBuy, true);
    },
  );

  it(
    "privacy: a buy and a sell are indistinguishable on-chain — same calldata shape, same ops, same events",
    { timeout: 300_000 },
    async () => {
      const { viem } = await nox.connect();
      const publicClient = await viem.getPublicClient();
      const [runtime] = await viem.getWalletClients();
      const { registry, settler, agentId: buyAgent } = await deployStack(viem, runtime);
      const sellAgent = await registerAgent(registry, runtime);

      // Same size, opposite sides, same position (first intent) in a fresh epoch of a fresh
      // agent: the ONLY difference between these two transactions is a bit inside a ciphertext.
      const buy = await submitIntent(settler, runtime, buyAgent, 100n * USDC, true);
      const sell = await submitIntent(settler, runtime, sellAgent, 100n * USDC, false);

      const buyTx = await publicClient.getTransaction({ hash: buy.hash });
      const sellTx = await publicClient.getTransaction({ hash: sell.hash });
      assert.equal(
        buyTx.input.length,
        sellTx.input.length,
        "a sell must not be shorter or longer in calldata than a buy",
      );
      assert.equal(
        buyTx.input.slice(0, 10),
        sellTx.input.slice(0, 10),
        "both sides go through the same function selector",
      );

      /**
       * A transaction's log fingerprint: which contract emitted what kind of event, in what
       * order, carrying how many bytes. It captures the exact NoxCompute op sequence the intent
       * triggered (WrapAsPublicHandle, two Selects, two Adds, the ACL grants) while ignoring the
       * ciphertext handles themselves, which are random by construction.
       */
      const fingerprint = (logs: readonly { address: string; topics: readonly string[]; data: string }[]) =>
        logs
          .map((log) => `${log.address}:${log.topics[0]}:${log.topics.length}:${log.data.length}`)
          .join(" | ");

      const buyReceipt = await publicClient.waitForTransactionReceipt({ hash: buy.hash });
      const sellReceipt = await publicClient.waitForTransactionReceipt({ hash: sell.hash });

      assert.ok(buyReceipt.logs.length > 0);
      assert.equal(
        fingerprint(buyReceipt.logs),
        fingerprint(sellReceipt.logs),
        "a buy and a sell must trigger the identical op sequence — no residual distinguisher",
      );

      // Both agents netted: the buy agent to +100 (buy), the sell agent to 100 (sell).
      const b = await closeEpoch(settler, runtime, buyAgent, 0n);
      const s = await closeEpoch(settler, runtime, sellAgent, 0n);
      const revealedBuy = await revealNet(b.net, b.direction);
      const revealedSell = await revealNet(s.net, s.direction);

      assert.equal(revealedBuy.netPlaintext, 100n * USDC);
      assert.equal(revealedBuy.netIsBuy, true);
      assert.equal(revealedSell.netPlaintext, 100n * USDC);
      assert.equal(
        revealedSell.netIsBuy,
        false,
        "a lone sell nets to a sell — the encrypted side reached the aggregate intact",
      );
    },
  );

  it(
    "forged-proof rejection: settle never trusts an off-chain plaintext",
    { timeout: 300_000 },
    async () => {
      const { viem } = await nox.connect();
      const [runtime] = await viem.getWalletClients();
      const { registry, settler, executor } = await deployStack(viem, runtime);

      // Agent A: net +300 (buy). This is the epoch under attack.
      const agentA = 0n;
      await submitIntent(settler, runtime, agentA, 100n * USDC, true);
      await submitIntent(settler, runtime, agentA, 250n * USDC, true);
      await submitIntent(settler, runtime, agentA, 50n * USDC, false);
      const a = await closeEpoch(settler, runtime, agentA, 0n);
      const revealA = await revealNet(a.net, a.direction);
      assert.equal(revealA.netPlaintext, 300n * USDC);

      // Agent B: a different net (-70, a sell) whose decryption proofs are perfectly valid —
      // for B's handles.
      const agentB = await registerAgent(registry, runtime);
      await submitIntent(settler, runtime, agentB, 30n * USDC, true);
      await submitIntent(settler, runtime, agentB, 100n * USDC, false);
      const b = await closeEpoch(settler, runtime, agentB, 0n);
      const revealB = await revealNet(b.net, b.direction);
      assert.equal(revealB.netPlaintext, 70n * USDC);
      assert.equal(revealB.netIsBuy, false);

      // (a) A valid proof for a DIFFERENT handle. The gateway's signature covers
      // (handle, plaintext), so re-pointing agent B's proof at agent A's stored net handle
      // changes the digest, the recovered signer is no longer the gateway, and NoxCompute
      // rejects it. Note this proof is genuine and its plaintext (70) is real — it is simply
      // not a statement about THIS handle.
      await assertRejectedByProofCheck(
        settler.write.settle([agentA, 0n, revealB.netProof, revealA.directionProof, 0n], {
          account: runtime.account,
        }),
        "another epoch's net proof",
      );
      // ...and the same for the direction bit: it is proof-gated exactly like the magnitude, so
      // an attacker cannot flip a buy into a sell by importing a sell proof from elsewhere.
      await assertRejectedByProofCheck(
        settler.write.settle([agentA, 0n, revealA.netProof, revealB.directionProof, 0n], {
          account: runtime.account,
        }),
        "another epoch's direction proof",
      );

      // (b) Corrupted / garbage proofs. `expectBadSignature: false` for these two: they die
      // even earlier — one on ECDSA's malformed-`s` guard, one on the length check — but both
      // die inside the same proof-validation call.
      const garbage = `0x${"ab".repeat(160)}` as const;
      const truncated = "0xdeadbeef" as const;
      await assertRejectedByProofCheck(
        settler.write.settle([agentA, 0n, garbage, revealA.directionProof, 0n], {
          account: runtime.account,
        }),
        "garbage net proof",
        false,
      );
      await assertRejectedByProofCheck(
        settler.write.settle([agentA, 0n, truncated, revealA.directionProof, 0n], {
          account: runtime.account,
        }),
        "truncated net proof",
        false,
      );
      await assertRejectedByProofCheck(
        settler.write.settle([agentA, 0n, revealA.netProof, garbage, 0n], {
          account: runtime.account,
        }),
        "garbage direction proof",
        false,
      );

      // (c) The sharpest test. The plaintext the contract will believe rides INSIDE the proof
      // (bytes [65:]), so an attacker's natural move is to keep the gateway's real signature and
      // edit the number it escorts. Flipping the last byte of the payload does exactly that — and
      // the signature no longer covers the mutated result.
      const tamperedTail = (revealA.netProof.slice(0, -2) +
        (revealA.netProof.endsWith("00") ? "01" : "00")) as `0x${string}`;
      await assertRejectedByProofCheck(
        settler.write.settle([agentA, 0n, tamperedTail, revealA.directionProof, 0n], {
          account: runtime.account,
        }),
        "net proof with an altered plaintext payload",
      );

      // Nothing settled, nothing executed: the contract never took an off-chain number on faith.
      const [, , settledAfterAttacks] = (await settler.read.epochStateOf([agentA, 0n])) as [
        bigint,
        boolean,
        boolean,
      ];
      assert.equal(settledAfterAttacks, false, "no forged proof may mark the epoch settled");
      assert.equal(await executor.read.callCount(), 0n, "no forged proof may reach the executor");

      // The honest proofs, on the same epoch and the same caller, do settle — proving the
      // rejections above were about the proofs and nothing else.
      await settler.write.settle(
        [agentA, 0n, revealA.netProof, revealA.directionProof, 0n],
        { account: runtime.account },
      );
      assert.equal(await executor.read.callCount(), 1n);
      assert.equal(await executor.read.lastNetAmount(), 300n * USDC);
      assert.equal(await executor.read.lastNetIsBuy(), true);
    },
  );

  it(
    "a net where sells dominate reveals the sell magnitude and a sell direction",
    { timeout: 300_000 },
    async () => {
      const { viem } = await nox.connect();
      const [runtime] = await viem.getWalletClients();
      const { settler, executor, agentId } = await deployStack(viem, runtime);

      // +40, -90, -10 => net -60 (sell).
      await submitIntent(settler, runtime, agentId, 40n * USDC, true);
      await submitIntent(settler, runtime, agentId, 90n * USDC, false);
      await submitIntent(settler, runtime, agentId, 10n * USDC, false);

      const { net, direction } = await closeEpoch(settler, runtime, agentId, 0n);
      const { netPlaintext, netIsBuy, netProof, directionProof } = await revealNet(net, direction);

      assert.equal(netPlaintext, 60n * USDC, "the net magnitude is |40 - 100| = 60");
      assert.equal(netIsBuy, false, "sells dominate, so the aggregate order is a sell");

      await settler.write.settle([agentId, 0n, netProof, directionProof, 0n], {
        account: runtime.account,
      });
      assert.equal(await executor.read.lastNetAmount(), 60n * USDC);
      assert.equal(await executor.read.lastNetIsBuy(), false);
    },
  );

  it(
    "a perfectly crossed epoch nets to zero: no revert, no leak, nothing executed",
    { timeout: 300_000 },
    async () => {
      const { viem } = await nox.connect();
      const publicClient = await viem.getPublicClient();
      const [runtime] = await viem.getWalletClients();
      const { settler, executor, agentId } = await deployStack(viem, runtime);

      // +120, +30, -150 => net 0. Buys and sells cross exactly.
      const alice = await submitIntent(settler, runtime, agentId, 120n * USDC, true);
      await submitIntent(settler, runtime, agentId, 30n * USDC, true);
      await submitIntent(settler, runtime, agentId, 150n * USDC, false);

      const { net, direction } = await closeEpoch(settler, runtime, agentId, 0n);
      const { netPlaintext, netIsBuy, netProof, directionProof } = await revealNet(net, direction);

      assert.equal(netPlaintext, 0n, "a fully crossed epoch nets to zero");
      assert.equal(
        netIsBuy,
        true,
        "ge(buy, sell) holds on equality: zero is reported as a buy, and the bit is meaningless",
      );

      // The individual intents that crossed are still sealed — a zero net must not be a
      // side channel back into who wanted what, in either size or side.
      assert.equal(await settler.read.isPubliclyDecryptable([alice.amount]), false);
      assert.equal(await settler.read.isPubliclyDecryptable([alice.side]), false);

      const hash = await settler.write.settle([agentId, 0n, netProof, directionProof, 0n], {
        account: runtime.account,
      });
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      const settled = await settler.getEvents.Settled(
        {},
        { fromBlock: receipt.blockNumber, toBlock: receipt.blockNumber },
      );
      assert.equal(settled.length, 1);
      assert.equal(settled[0].args.netPlaintext, 0n);

      // There is nothing to trade, and the direction bit means nothing on a zero net: the
      // executor must not be poked with it. (IExecutionTarget documents both facts.)
      assert.equal(await executor.read.callCount(), 0n);
    },
  );

  it(
    "authorization: only the agent's registered runtime may submit, close or settle",
    { timeout: 300_000 },
    async () => {
      const { viem } = await nox.connect();
      const [runtime, mallory] = await viem.getWalletClients();
      const { settler, agentId } = await deployStack(viem, runtime);

      // Every entry point is gated before it ever touches a handle or a proof.
      await assertRevertsWithError(
        settler.write.submitIntent([agentId, ZERO_HANDLE, "0x", ZERO_HANDLE, "0x"], {
          account: mallory.account,
        }),
        "NetSettlerNotAgentRuntime",
      );
      await assertRevertsWithError(
        settler.write.submitIntent([agentId, ZERO_HANDLE, ZERO_HANDLE, "0x"], {
          account: mallory.account,
        }),
        "NetSettlerNotAgentRuntime",
      );
      await assertRevertsWithError(
        settler.write.closeEpoch([agentId], { account: mallory.account }),
        "NetSettlerNotAgentRuntime",
      );
      await assertRevertsWithError(
        settler.write.settle([agentId, 0n, "0x", "0x", 0n], { account: mallory.account }),
        "NetSettlerNotAgentRuntime",
      );

      // The runtime files a real epoch; Mallory still cannot close or settle it.
      await submitIntent(settler, runtime, agentId, 100n * USDC, true);
      await assertRevertsWithError(
        settler.write.closeEpoch([agentId], { account: mallory.account }),
        "NetSettlerNotAgentRuntime",
      );

      const { net, direction } = await closeEpoch(settler, runtime, agentId, 0n);
      const { netProof, directionProof } = await revealNet(net, direction);

      // Even holding perfectly valid public-decryption proofs, an outsider cannot settle.
      await assertRevertsWithError(
        settler.write.settle([agentId, 0n, netProof, directionProof, 0n], {
          account: mallory.account,
        }),
        "NetSettlerNotAgentRuntime",
      );

      // An unknown agentId has no runtime at all.
      await assertRevertsWithError(
        settler.write.closeEpoch([99n], { account: runtime.account }),
        "UnknownAgent",
      );
    },
  );

  it(
    "epoch hygiene: no empty close, no early settle, no double settle, no writing into a closed epoch",
    { timeout: 300_000 },
    async () => {
      const { viem } = await nox.connect();
      const [runtime] = await viem.getWalletClients();
      const { settler, executor, agentId } = await deployStack(viem, runtime);

      // Closing an epoch nobody submitted to reveals a net of zero over an empty set — a
      // pointless public statement, and one an adversary could use to fingerprint quiet epochs.
      await assertRevertsWithError(
        settler.write.closeEpoch([agentId], { account: runtime.account }),
        "NetSettlerEmptyEpoch",
      );

      await submitIntent(settler, runtime, agentId, 100n * USDC, true);

      // Settling an epoch that was never closed: there is no net handle to prove anything about.
      await assertRevertsWithError(
        settler.write.settle([agentId, 0n, "0x", "0x", 0n], { account: runtime.account }),
        "NetSettlerEpochNotClosed",
      );

      const { net, direction } = await closeEpoch(settler, runtime, agentId, 0n);
      const { netProof, directionProof } = await revealNet(net, direction);

      await settler.write.settle([agentId, 0n, netProof, directionProof, 0n], {
        account: runtime.account,
      });
      assert.equal(await executor.read.callCount(), 1n);

      // Replay: the same epoch, the same (valid!) proofs, a second time.
      await assertRevertsWithError(
        settler.write.settle([agentId, 0n, netProof, directionProof, 0n], {
          account: runtime.account,
        }),
        "NetSettlerEpochAlreadySettled",
      );
      assert.equal(await executor.read.callCount(), 1n, "a replay must not re-execute the order");

      // A closed epoch is frozen: a late intent lands in the NEXT epoch and cannot mutate the
      // aggregate that was already revealed and settled.
      await submitIntent(settler, runtime, agentId, 7n * USDC, false);
      assert.equal(await settler.read.currentEpoch([agentId]), 1n);

      const [count0] = (await settler.read.epochStateOf([agentId, 0n])) as [
        bigint,
        boolean,
        boolean,
      ];
      const [count1, closed1] = (await settler.read.epochStateOf([agentId, 1n])) as [
        bigint,
        boolean,
        boolean,
      ];
      assert.equal(count0, 1n, "the settled epoch's intent set is frozen");
      assert.equal(count1, 1n, "the late intent landed in the open epoch");
      assert.equal(closed1, false);
      assert.equal(
        await settler.read.netOf([agentId, 0n]),
        net,
        "the settled epoch's revealed net handle is immutable",
      );

      // Settling the fresh epoch must not be possible with the previous epoch's proofs either:
      // a proof is a statement about one handle, and epoch 1 has a different one.
      await settler.write.closeEpoch([agentId], { account: runtime.account });
      await assertRejectedByProofCheck(
        settler.write.settle([agentId, 1n, netProof, directionProof, 0n], {
          account: runtime.account,
        }),
        "epoch 0's proofs replayed against epoch 1",
      );
    },
  );

  it(
    "accepts an already-encrypted handle the runtime holds (the direct euint256 path)",
    { timeout: 300_000 },
    async () => {
      const { viem } = await nox.connect();
      const [runtime, outsider] = await viem.getWalletClients();
      const { settler, agentId } = await deployStack(viem, runtime);

      // A handle that already lives on-chain — here a confidential balance the runtime holds,
      // standing in for a depositor position the runtime is ACL'd on. The settler needs its own
      // Nox grant before it can fold the ciphertext into an epoch.
      const underlying = await viem.deployContract("MockUSDC");
      const asset = await viem.deployContract("OccultaUSDC", [
        underlying.address,
        "Occulta USDC",
        "ocUSDC",
        CONTRACT_URI,
      ]);
      await underlying.write.mint([runtime.account.address, 80n * USDC]);
      await underlying.write.approve([asset.address, 80n * USDC], { account: runtime.account });
      await asset.write.wrap([runtime.account.address, 80n * USDC], { account: runtime.account });

      const balanceHandle = (await asset.read.confidentialBalanceOf([
        runtime.account.address,
      ])) as `0x${string}`;
      await runtime.writeContract({
        address: NOX_COMPUTE_ADDRESS,
        abi: noxComputeAbi,
        functionName: "allow",
        args: [balanceHandle, settler.address],
      });

      // THIS is the overload that made a plaintext side attributable: `confidentialBalanceOf` is
      // a public view keyed by address, so anyone can match the handle folded in here against a
      // named depositor. The side therefore arrives encrypted here too — there is no overload of
      // `submitIntent` left that takes a plaintext bool.
      const side = await nox.encryptInput(true, "bool", settler.address);
      await settler.write.submitIntent([agentId, balanceHandle, side.handle, side.handleProof], {
        account: runtime.account,
      });
      await submitIntent(settler, runtime, agentId, 20n * USDC, false);

      const { net, direction } = await closeEpoch(settler, runtime, agentId, 0n);
      const { netPlaintext, netIsBuy } = await revealNet(net, direction);
      assert.equal(netPlaintext, 60n * USDC, "80 (existing handle) - 20 = 60");
      assert.equal(netIsBuy, true);

      // Neither the pre-existing handle nor the side attached to it is made public by netting.
      assert.equal(await settler.read.isPubliclyDecryptable([balanceHandle]), false);
      assert.equal(
        await settler.read.isAllowedFor([balanceHandle, outsider.account.address]),
        false,
      );
      assert.equal(await settler.read.isPubliclyDecryptable([side.handle]), false);
      assert.equal(
        await settler.read.isAllowedFor([side.handle, outsider.account.address]),
        false,
        "the side of a publicly-lookup-able balance handle is exactly what must not leak",
      );
      await assertNotPubliclyDecryptable(side.handle, "the side of a pre-existing handle");
    },
  );

  it(
    "rejects a handle the caller has no Nox grant on",
    { timeout: 300_000 },
    async () => {
      const { viem } = await nox.connect();
      const [runtime, stranger] = await viem.getWalletClients();
      const { settler, agentId } = await deployStack(viem, runtime);

      // A confidential balance belonging to somebody else: the runtime holds no ACL on it, so it
      // cannot smuggle a third party's ciphertext into the epoch.
      const underlying = await viem.deployContract("MockUSDC");
      const asset = await viem.deployContract("OccultaUSDC", [
        underlying.address,
        "Occulta USDC",
        "ocUSDC",
        CONTRACT_URI,
      ]);
      await underlying.write.mint([stranger.account.address, 10n * USDC]);
      await underlying.write.approve([asset.address, 10n * USDC], { account: stranger.account });
      await asset.write.wrap([stranger.account.address, 10n * USDC], { account: stranger.account });

      const strangerHandle = (await asset.read.confidentialBalanceOf([
        stranger.account.address,
      ])) as `0x${string}`;

      const side = await nox.encryptInput(true, "bool", settler.address);
      await assertRevertsWithError(
        settler.write.submitIntent([agentId, strangerHandle, side.handle, side.handleProof], {
          account: runtime.account,
        }),
        "NetSettlerUnauthorizedIntent",
      );
    },
  );
});
