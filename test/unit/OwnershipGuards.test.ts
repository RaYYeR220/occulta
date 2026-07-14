import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { nox } from "@iexec-nox/nox-hardhat-plugin";

const CONTRACT_URI = "https://occulta.example/ovault.json";

/** A non-zero placeholder address. The renounce-guarded contracts only reject a zero
 *  dependency address at construction and never call these deps, so any non-zero value
 *  deploys a live instance to test the ownership guard against. */
const DUMMY = "0x0000000000000000000000000000000000000001" as const;
const DUMMY_2 = "0x0000000000000000000000000000000000000002" as const;
const DUMMY_3 = "0x0000000000000000000000000000000000000003" as const;
const DUMMY_4 = "0x0000000000000000000000000000000000000004" as const;
const FEE = 10000;

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

describe("Ownership guards (renounceOwnership disabled)", () => {
  it(
    "OccultaVault.renounceOwnership reverts with RenounceDisabled",
    { timeout: 180_000 },
    async () => {
      const { viem } = await nox.connect();
      const [owner] = await viem.getWalletClients();

      const underlying = await viem.deployContract("MockUSDC");
      const asset = await viem.deployContract("OccultaUSDC", [
        underlying.address,
        "Occulta USDC",
        "ocUSDC",
        CONTRACT_URI,
      ]);
      const vault = await viem.deployContract("OccultaVault", [
        asset.address,
        "Occulta Vault USDC",
        "ovUSDC",
        CONTRACT_URI,
        owner.account.address,
      ]);

      await assertRevertsWithError(
        vault.write.renounceOwnership({ account: owner.account }),
        "RenounceDisabled",
      );
      assert.equal(
        (await vault.read.owner() as string).toLowerCase(),
        owner.account.address.toLowerCase(),
        "owner must remain unchanged after a blocked renounce",
      );
    },
  );

  it(
    "AaveAdapter.renounceOwnership reverts with RenounceDisabled",
    { timeout: 180_000 },
    async () => {
      const { viem } = await nox.connect();
      const [owner] = await viem.getWalletClients();

      const adapter = await viem.deployContract("AaveAdapter", [DUMMY, owner.account.address]);

      await assertRevertsWithError(
        adapter.write.renounceOwnership({ account: owner.account }),
        "RenounceDisabled",
      );
      assert.equal(
        (await adapter.read.owner() as string).toLowerCase(),
        owner.account.address.toLowerCase(),
      );
    },
  );

  it(
    "UniswapAdapter.renounceOwnership reverts with RenounceDisabled",
    { timeout: 180_000 },
    async () => {
      const { viem } = await nox.connect();
      const [owner] = await viem.getWalletClients();

      const adapter = await viem.deployContract("UniswapAdapter", [DUMMY, owner.account.address]);

      await assertRevertsWithError(
        adapter.write.renounceOwnership({ account: owner.account }),
        "RenounceDisabled",
      );
      assert.equal(
        (await adapter.read.owner() as string).toLowerCase(),
        owner.account.address.toLowerCase(),
      );
    },
  );

  it(
    "OccultaExecutor.renounceOwnership reverts with RenounceDisabled",
    { timeout: 180_000 },
    async () => {
      const { viem } = await nox.connect();
      const [owner] = await viem.getWalletClients();

      const aave = await viem.deployContract("AaveAdapter", [DUMMY, owner.account.address]);
      const uni = await viem.deployContract("UniswapAdapter", [DUMMY_2, owner.account.address]);
      const executor = await viem.deployContract("OccultaExecutor", [
        aave.address,
        uni.address,
        DUMMY_3, // usdc
        DUMMY_4, // weth
        FEE,
        DUMMY, // settler
        owner.account.address,
      ]);

      await assertRevertsWithError(
        executor.write.renounceOwnership({ account: owner.account }),
        "RenounceDisabled",
      );
      assert.equal(
        (await executor.read.owner() as string).toLowerCase(),
        owner.account.address.toLowerCase(),
      );
    },
  );
});
