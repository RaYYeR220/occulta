import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { nox } from "@iexec-nox/nox-hardhat-plugin";

const ZERO_HANDLE = `0x${"00".repeat(32)}` as const;

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
});
