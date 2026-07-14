import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { nox } from "@iexec-nox/nox-hardhat-plugin";

const ZERO_HANDLE = `0x${"00".repeat(32)}` as const;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const;
/** 1 USDC at the 6-decimal scale the rest of the stack nets in. */
const USDC = 1_000_000n;

/** Encrypts every value in `values` for `applicationContract`, in order. */
async function encryptPolicy(values: bigint[], applicationContract: `0x${string}`) {
  const handles: `0x${string}`[] = [];
  const proofs: `0x${string}`[] = [];
  for (const value of values) {
    const { handle, handleProof } = await nox.encryptInput(value, "uint256", applicationContract);
    handles.push(handle);
    proofs.push(handleProof);
  }
  return { handles, proofs };
}

type Viem = Awaited<ReturnType<typeof nox.connect>>["viem"];
type Registry = Awaited<ReturnType<Viem["deployContract"]>>;

/** Registers one agent with a sealed 4-slot policy for `runtime`; returns its agentId. The
 *  strategist must be `viem.getWalletClients()[0]` — `nox.encryptInput` binds the input proof
 *  to that account, and `Nox.fromExternal` requires the registrar's `msg.sender` to match. */
async function registerAgent(
  registry: Registry,
  strategist: { account: { address: `0x${string}` } },
  runtime: `0x${string}`,
): Promise<bigint> {
  const { handles, proofs } = await encryptPolicy([6000n, 500n, 20000n, 3000n], registry.address);
  const agentId = (await registry.read.agentCount()) as bigint;
  await registry.write.registerAgent(
    ["Alpha", "Mandate", runtime, handles, proofs],
    { account: strategist.account },
  );
  return agentId;
}

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

describe("StrategyRegistry", () => {
  it(
    "seals a strategist's policy so only the named runtime can decrypt it",
    { timeout: 180_000 },
    async () => {
      const { viem } = await nox.connect();
      const [strategist, runtime, outsider] = await viem.getWalletClients();

      const registry = await viem.deployContract("StrategyRegistry");

      const policyValues = [6000n, 500n, 20000n, 3000n];
      const { handles, proofs } = await encryptPolicy(policyValues, registry.address);

      await registry.write.registerAgent(
        [
          "Alpha Vault",
          "Delta-neutral basis trade on ETH perpetuals",
          runtime.account.address,
          handles,
          proofs,
        ],
        { account: strategist.account },
      );

      assert.equal(await registry.read.agentCount(), 1n);

      const meta = await registry.read.metaOf([0n]);
      assert.equal(meta.strategist.toLowerCase(), strategist.account.address.toLowerCase());
      assert.equal(meta.runtime.toLowerCase(), runtime.account.address.toLowerCase());
      assert.equal(meta.name, "Alpha Vault");
      assert.equal(meta.mandate, "Delta-neutral basis trade on ETH perpetuals");
      assert.equal(meta.active, true);

      for (let i = 0; i < policyValues.length; i++) {
        assert.equal(
          await registry.read.isRuntimeAllowed([0n, BigInt(i)]),
          true,
          `runtime should be allowed on policy slot ${i}`,
        );

        const handle = await registry.read.policyOf([0n, BigInt(i)]);

        assert.equal(
          await registry.read.isAllowedFor([handle, outsider.account.address]),
          false,
          `outsider must not be allowed on policy slot ${i}`,
        );

        // Design decision (see StrategyRegistry NatSpec): the strategist is not
        // granted an on-chain decrypt right over their own sealed policy. Only
        // the registry itself (to reuse the handle) and the named runtime are.
        assert.equal(
          await registry.read.isAllowedFor([handle, strategist.account.address]),
          false,
          `strategist must not be allowed on policy slot ${i}`,
        );
      }
    },
  );

  it("reverts on an empty policy", { timeout: 180_000 }, async () => {
    const { viem } = await nox.connect();
    const [strategist, runtime] = await viem.getWalletClients();
    const registry = await viem.deployContract("StrategyRegistry");

    await assertRevertsWithError(
      registry.write.registerAgent(
        ["Empty", "No policy", runtime.account.address, [], []],
        { account: strategist.account },
      ),
      "EmptyPolicy",
    );
  });

  it("reverts when policy and proofs lengths mismatch", { timeout: 180_000 }, async () => {
    const { viem } = await nox.connect();
    const [strategist, runtime] = await viem.getWalletClients();
    const registry = await viem.deployContract("StrategyRegistry");

    await assertRevertsWithError(
      registry.write.registerAgent(
        [
          "Mismatched",
          "Bad arity",
          runtime.account.address,
          [ZERO_HANDLE, ZERO_HANDLE],
          ["0x"],
        ],
        { account: strategist.account },
      ),
      "LengthMismatch",
    );
  });

  it("reverts on an unknown agentId", { timeout: 180_000 }, async () => {
    const { viem } = await nox.connect();
    const registry = await viem.deployContract("StrategyRegistry");

    await assertRevertsWithError(registry.read.metaOf([0n]), "UnknownAgent");
    await assertRevertsWithError(registry.read.policyOf([0n, 0n]), "UnknownAgent");
    await assertRevertsWithError(registry.read.isRuntimeAllowed([0n, 0n]), "UnknownAgent");
  });

  it(
    "keeps each agent's sealed policy isolated from every other agent",
    { timeout: 180_000 },
    async () => {
      const { viem } = await nox.connect();
      const [strategist, runtimeA, runtimeB] = await viem.getWalletClients();

      const registry = await viem.deployContract("StrategyRegistry");

      const policyA = [6000n, 500n, 20000n, 3000n];
      const { handles: handlesA, proofs: proofsA } = await encryptPolicy(policyA, registry.address);
      await registry.write.registerAgent(
        ["Agent A", "Mandate A", runtimeA.account.address, handlesA, proofsA],
        { account: strategist.account },
      );

      const policyB = [1000n, 250n, 15000n, 4000n];
      const { handles: handlesB, proofs: proofsB } = await encryptPolicy(policyB, registry.address);
      await registry.write.registerAgent(
        ["Agent B", "Mandate B", runtimeB.account.address, handlesB, proofsB],
        { account: strategist.account },
      );

      assert.equal(await registry.read.agentCount(), 2n);

      for (let i = 0; i < policyA.length; i++) {
        const handleA = await registry.read.policyOf([0n, BigInt(i)]);
        const handleB = await registry.read.policyOf([1n, BigInt(i)]);
        assert.notEqual(handleA, handleB, `policy slot ${i} handles should differ across agents`);

        // Agent 0's runtime must not gain any access to agent 1's policy.
        assert.equal(
          await registry.read.isAllowedFor([handleB, runtimeA.account.address]),
          false,
          `agent-0 runtime must not be allowed on agent-1 policy slot ${i}`,
        );
      }
    },
  );

  it("registerAgent rejects a zero runtime", { timeout: 180_000 }, async () => {
    const { viem } = await nox.connect();
    const [strategist] = await viem.getWalletClients();
    const registry = await viem.deployContract("StrategyRegistry");

    const { handles, proofs } = await encryptPolicy([6000n, 500n, 20000n, 3000n], registry.address);
    await assertRevertsWithError(
      registry.write.registerAgent(
        ["Zero", "No runtime", ZERO_ADDRESS, handles, proofs],
        { account: strategist.account },
      ),
      "ZeroRuntime",
    );
  });

  it(
    "only the strategist may setActive or setRuntime; setRuntime rejects the zero address",
    { timeout: 180_000 },
    async () => {
      const { viem } = await nox.connect();
      const [strategist, runtime, mallory] = await viem.getWalletClients();
      const registry = await viem.deployContract("StrategyRegistry");
      const agentId = await registerAgent(registry, strategist, runtime.account.address);

      // The registered runtime is NOT the strategist and may not touch lifecycle controls.
      await assertRevertsWithError(
        registry.write.setActive([agentId, false], { account: runtime.account }),
        "NotStrategist",
      );
      await assertRevertsWithError(
        registry.write.setRuntime([agentId, mallory.account.address], { account: mallory.account }),
        "NotStrategist",
      );

      // The strategist cannot rotate the runtime to the zero address.
      await assertRevertsWithError(
        registry.write.setRuntime([agentId, ZERO_ADDRESS], { account: strategist.account }),
        "ZeroRuntime",
      );

      // ...and an unknown agent has no strategist at all.
      await assertRevertsWithError(
        registry.write.setActive([99n, false], { account: strategist.account }),
        "UnknownAgent",
      );
    },
  );

  it(
    "setRuntime rotates the decrypt grant to the new runtime on every policy slot (additive)",
    { timeout: 180_000 },
    async () => {
      const { viem } = await nox.connect();
      const [strategist, oldRuntime, newRuntime] = await viem.getWalletClients();
      const registry = await viem.deployContract("StrategyRegistry");
      const agentId = await registerAgent(registry, strategist, oldRuntime.account.address);

      // Before rotation: the old runtime is the meta.runtime and is allowed on every slot.
      for (let i = 0; i < 4; i++) {
        assert.equal(await registry.read.isRuntimeAllowed([agentId, BigInt(i)]), true);
      }

      await registry.write.setRuntime([agentId, newRuntime.account.address], {
        account: strategist.account,
      });

      const meta = await registry.read.metaOf([agentId]);
      assert.equal(
        meta.runtime.toLowerCase(),
        newRuntime.account.address.toLowerCase(),
        "meta.runtime must point at the new runtime after rotation",
      );

      for (let i = 0; i < 4; i++) {
        // isRuntimeAllowed now reads against the NEW runtime — it must be true on every slot.
        assert.equal(
          await registry.read.isRuntimeAllowed([agentId, BigInt(i)]),
          true,
          `new runtime must be allowed on policy slot ${i}`,
        );
        const handle = await registry.read.policyOf([agentId, BigInt(i)]);
        assert.equal(
          await registry.read.isAllowedFor([handle, newRuntime.account.address]),
          true,
          `new runtime must decrypt policy slot ${i}`,
        );
        // Rotation is ADDITIVE by ACL-model limitation (no persistent revoke exists in Nox):
        // the old runtime retains read access on the policy. Asserted here so the accepted
        // limitation is documented in a passing test, not merely in a comment.
        assert.equal(
          await registry.read.isAllowedFor([handle, oldRuntime.account.address]),
          true,
          `old runtime retains policy access on slot ${i} — additive rotation`,
        );
      }
    },
  );

  it(
    "setActive(false) revokes the runtime's settler access; setActive(true) restores it",
    { timeout: 300_000 },
    async () => {
      const { viem } = await nox.connect();
      // Runtime and strategist are both account 0: encryptInput binds to it for both the
      // policy seal (register) and the intent submission (settle path).
      const [runtime] = await viem.getWalletClients();
      const registry = await viem.deployContract("StrategyRegistry");
      const executor = await viem.deployContract("MockExecutionTarget");
      const settler = await viem.deployContract("NetSettler", [registry.address, executor.address]);
      const agentId = await registerAgent(registry, runtime, runtime.account.address);

      // A real intent lands while the agent is active.
      const size = await nox.encryptInput(100n * USDC, "uint256", settler.address);
      const side = await nox.encryptInput(true, "bool", settler.address);
      await settler.write.submitIntent(
        [agentId, size.handle, size.handleProof, side.handle, side.handleProof],
        { account: runtime.account },
      );

      // Deactivate: the runtime's write access to the settler must vanish — this is the dead
      // `active` check finally becoming enforceable.
      await registry.write.setActive([agentId, false], { account: runtime.account });
      assert.equal((await registry.read.metaOf([agentId])).active, false);
      await assertRevertsWithError(
        settler.write.closeEpoch([agentId], { account: runtime.account }),
        "NetSettlerAgentInactive",
      );

      // Reactivate: access is restored and the epoch closes normally.
      await registry.write.setActive([agentId, true], { account: runtime.account });
      assert.equal((await registry.read.metaOf([agentId])).active, true);
      await settler.write.closeEpoch([agentId], { account: runtime.account });
      assert.equal(await settler.read.currentEpoch([agentId]), 1n, "closing advances the epoch");
    },
  );
});
