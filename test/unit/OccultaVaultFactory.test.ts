import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { getAddress, keccak256, parseAbi, toHex } from "viem";
import { nox, NOX_COMPUTE_ADDRESS } from "@iexec-nox/nox-hardhat-plugin";

/** 1 USDC at the real 6-decimal Aave Sepolia USDC scale. */
const AMOUNT = 1_000_000n;

const CONTRACT_URI = "https://occulta.example/ovault.json";
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const;

/** Minimal ABI slice of the deployed NoxCompute proxy, used to grant the vault ACL access to a
 * depositor-held handle before it is handed to the vault (mirrors the vault's own unit tests). */
const noxComputeAbi = parseAbi(["function allow(bytes32 handle, address account) external"]);

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

/** Deploys a fresh MockUSDC + OccultaUSDC pair to use as a factory-created vault's asset. */
async function deployAsset(viem: Awaited<ReturnType<typeof nox.connect>>["viem"]) {
  const underlying = await viem.deployContract("MockUSDC");
  const asset = await viem.deployContract("OccultaUSDC", [
    underlying.address,
    "Occulta USDC",
    "ocUSDC",
    CONTRACT_URI,
  ]);
  return { underlying, asset };
}

/**
 * Pulls the deployed vault address out of a `createVault` receipt by reading `topics[1]` (the
 * indexed `vault` param) directly, rather than full-ABI-decoding the event. `VaultCreated` has
 * five params and no `salt`; decoding against any other shape would silently misread the
 * address, so this reads the one topic slot that matters instead.
 */
function vaultAddressFromReceipt(
  receipt: { logs: readonly { address: string; topics: readonly `0x${string}`[] }[] },
  factoryAddress: string,
): `0x${string}` {
  const log = receipt.logs.find(
    (l) => l.address.toLowerCase() === factoryAddress.toLowerCase() && l.topics.length === 4,
  );
  assert.ok(log, "VaultCreated log not found in receipt");
  return getAddress(`0x${log!.topics[1]!.slice(-40)}`);
}

describe("OccultaVaultFactory", () => {
  it(
    "deploys a vault via CREATE2 at the address predictVaultAddress predicts, owned by agentRuntime",
    { timeout: 240_000 },
    async () => {
      const { viem } = await nox.connect();
      const publicClient = await viem.getPublicClient();
      const [deployer, agentRuntime] = await viem.getWalletClients();

      const { asset } = await deployAsset(viem);
      const factory = await viem.deployContract("OccultaVaultFactory");

      const salt = keccak256(toHex("occulta-vault-predict"));
      const args = [
        asset.address,
        "Occulta Vault USDC",
        "ovUSDC",
        CONTRACT_URI,
        agentRuntime.account.address,
        salt,
      ] as const;

      const predicted = getAddress(
        (await factory.read.predictVaultAddress(args)) as string,
      );

      const hash = await factory.write.createVault(args, { account: deployer.account });
      const receipt = await publicClient.waitForTransactionReceipt({ hash });

      const vaultAddress = vaultAddressFromReceipt(receipt, factory.address);
      assert.equal(
        vaultAddress,
        predicted,
        "predictVaultAddress must equal the actual CREATE2 deployment address",
      );

      const code = await publicClient.getCode({ address: vaultAddress });
      assert.ok(code && code !== "0x", "vault must have deployed bytecode at the predicted address");

      const vault = await viem.getContractAt("OccultaVault", vaultAddress);
      assert.equal(
        getAddress((await vault.read.owner()) as string),
        getAddress(agentRuntime.account.address),
        "agentRuntime must be the deployed vault's Ownable owner",
      );
    },
  );

  it(
    "different salts deploy different vaults; replaying the same salt and args reverts on the CREATE2 collision",
    { timeout: 240_000 },
    async () => {
      const { viem } = await nox.connect();
      const publicClient = await viem.getPublicClient();
      const [deployer, agentRuntime] = await viem.getWalletClients();

      const { asset } = await deployAsset(viem);
      const factory = await viem.deployContract("OccultaVaultFactory");

      const baseArgs = [
        asset.address,
        "Occulta Vault USDC",
        "ovUSDC",
        CONTRACT_URI,
        agentRuntime.account.address,
      ] as const;

      const saltA = keccak256(toHex("occulta-vault-salt-a"));
      const saltB = keccak256(toHex("occulta-vault-salt-b"));

      const hashA = await factory.write.createVault([...baseArgs, saltA], {
        account: deployer.account,
      });
      const receiptA = await publicClient.waitForTransactionReceipt({ hash: hashA });
      const vaultA = vaultAddressFromReceipt(receiptA, factory.address);

      const hashB = await factory.write.createVault([...baseArgs, saltB], {
        account: deployer.account,
      });
      const receiptB = await publicClient.waitForTransactionReceipt({ hash: hashB });
      const vaultB = vaultAddressFromReceipt(receiptB, factory.address);

      assert.notEqual(vaultA, vaultB, "different salts must deploy to different addresses");

      // Same salt, identical args: the CREATE2 target already holds code, so the deployment
      // must fail.
      await assert.rejects(
        factory.write.createVault([...baseArgs, saltA], { account: deployer.account }),
        "replaying the same salt with identical args must revert (CREATE2 collision)",
      );
    },
  );

  it(
    "reverts with a custom error when agentRuntime is the zero address",
    { timeout: 240_000 },
    async () => {
      const { viem } = await nox.connect();
      const [deployer] = await viem.getWalletClients();

      const { asset } = await deployAsset(viem);
      const factory = await viem.deployContract("OccultaVaultFactory");

      await assertRevertsWithError(
        factory.write.createVault(
          [
            asset.address,
            "Occulta Vault USDC",
            "ovUSDC",
            CONTRACT_URI,
            ZERO_ADDRESS,
            keccak256(toHex("occulta-vault-zero-runtime")),
          ],
          { account: deployer.account },
        ),
        "OccultaVaultFactoryZeroAgentRuntime",
      );
    },
  );

  it(
    "sanity: a factory-created vault is fully functional — requestDeposit's pending bucket decrypts to the deposited amount",
    { timeout: 240_000 },
    async () => {
      const { viem } = await nox.connect();
      const publicClient = await viem.getPublicClient();
      // `nox.decrypt` is bound to `viem.getWalletClients()[0]`, so the depositor here must be
      // account 0 to read its own pending bucket back directly.
      const [depositor, agentRuntime] = await viem.getWalletClients();

      const { underlying, asset } = await deployAsset(viem);
      const factory = await viem.deployContract("OccultaVaultFactory");

      const salt = keccak256(toHex("occulta-vault-functional"));
      const hash = await factory.write.createVault(
        [
          asset.address,
          "Occulta Vault USDC",
          "ovUSDC",
          CONTRACT_URI,
          agentRuntime.account.address,
          salt,
        ],
        { account: depositor.account },
      );
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      const vaultAddress = vaultAddressFromReceipt(receipt, factory.address);
      const vault = await viem.getContractAt("OccultaVault", vaultAddress);

      // Depositor prep, per the vault's ACL requirements: wrap plaintext USDC into a
      // confidential balance, grant the vault operator status on the asset, and grant the
      // vault Nox ACL access to the resulting balance handle.
      await underlying.write.mint([depositor.account.address, AMOUNT]);
      await underlying.write.approve([asset.address, AMOUNT], { account: depositor.account });
      await asset.write.wrap([depositor.account.address, AMOUNT], { account: depositor.account });

      const until = BigInt(Math.floor(Date.now() / 1000) + 24 * 3600);
      await asset.write.setOperator([vault.address, until], { account: depositor.account });

      const balanceHandle = (await asset.read.confidentialBalanceOf([
        depositor.account.address,
      ])) as `0x${string}`;

      await depositor.writeContract({
        address: NOX_COMPUTE_ADDRESS,
        abi: noxComputeAbi,
        functionName: "allow",
        args: [balanceHandle, vault.address],
      });

      await vault.write.requestDeposit(
        [balanceHandle, depositor.account.address, depositor.account.address],
        { account: depositor.account },
      );

      const pendingHandle = (await vault.read.pendingDepositRequest([
        depositor.account.address,
      ])) as `0x${string}`;
      const { value: pending } = await nox.decrypt(pendingHandle);
      assert.equal(pending, AMOUNT, "pending deposit bucket must equal the requested amount");
    },
  );
});
