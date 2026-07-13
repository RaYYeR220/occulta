import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { parseAbi } from "viem";
import { nox, NOX_COMPUTE_ADDRESS } from "@iexec-nox/nox-hardhat-plugin";

/** 1 USDC at the real 6-decimal Aave Sepolia USDC scale. */
const AMOUNT = 1_000_000n;

/** Mirrors the vault's `_decimalsOffset() = 6` virtual-share inflation defense. */
const DECIMALS_OFFSET = 6n;
const SEED_SHARE_MULTIPLIER = 10n ** DECIMALS_OFFSET;

const CONTRACT_URI = "https://occulta.example/ovault.json";
const ZERO_HANDLE = `0x${"00".repeat(32)}` as const;

/** Minimal ABI slice of the deployed NoxCompute proxy, used to grant the vault ACL access to a
 * depositor-held handle before it is handed to the vault (mirrors the reference e2e pattern). */
const noxComputeAbi = parseAbi(["function allow(bytes32 handle, address account) external"]);

/**
 * Decrypts a `euint256` handle to a plain bigint. An uninitialized storage slot (nothing was
 * ever written into it, e.g. `confidentialTotalSupply()` before the first mint) reads back as
 * `ZERO_HANDLE`; the SDK refuses to decrypt that, so it is short-circuited to `0n` here —
 * nothing was ever written, so the value genuinely is zero.
 */
async function decryptAmount(handle: `0x${string}`): Promise<bigint> {
  if (handle === ZERO_HANDLE) return 0n;
  const { value } = await nox.decrypt(handle);
  return value as bigint;
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

/** Deploys a fresh MockUSDC + OccultaUSDC + OccultaVault stack. `agent` is set as the vault's
 * Ownable owner — the only account allowed to call `approveDeposit` / `approveRedeem`. */
async function deployVault(viem: Awaited<ReturnType<typeof nox.connect>>["viem"], agent: { account: { address: `0x${string}` } }) {
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
    agent.account.address,
  ]);
  return { underlying, asset, vault };
}

/**
 * Depositor prep, per the vault's ACL requirements: (a) wrap plaintext USDC into a confidential
 * balance, (b) grant the vault operator status on the asset so it can pull funds, (c) grant the
 * vault Nox ACL on the resulting balance handle so it can consume the ciphertext. Returns the
 * post-wrap balance handle, ready to be passed into `requestDeposit`.
 */
async function prepDeposit(
  asset: Awaited<ReturnType<typeof deployVault>>["asset"],
  vault: Awaited<ReturnType<typeof deployVault>>["vault"],
  underlying: Awaited<ReturnType<typeof deployVault>>["underlying"],
  depositor: Awaited<ReturnType<Awaited<ReturnType<typeof nox.connect>>["viem"]["getWalletClients"]>>[number],
  amount: bigint,
): Promise<`0x${string}`> {
  await underlying.write.mint([depositor.account.address, amount]);
  await underlying.write.approve([asset.address, amount], { account: depositor.account });
  await asset.write.wrap([depositor.account.address, amount], { account: depositor.account });

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

  return balanceHandle;
}

/** Runs prep + request + approve + claim for a self-serving depositor who is also the vault's
 * agent (owner). Returns the deployed stack, ready for further assertions or a redeem flow. */
async function setupDepositedVault(
  viem: Awaited<ReturnType<typeof nox.connect>>["viem"],
  amount: bigint,
) {
  const [signer] = await viem.getWalletClients();
  const { underlying, asset, vault } = await deployVault(viem, signer);

  const balanceHandle = await prepDeposit(asset, vault, underlying, signer, amount);
  await vault.write.requestDeposit(
    [balanceHandle, signer.account.address, signer.account.address],
    { account: signer.account },
  );
  const pendingHandle = (await vault.read.pendingDepositRequest([
    signer.account.address,
  ])) as `0x${string}`;
  await vault.write.approveDeposit([pendingHandle, signer.account.address], {
    account: signer.account,
  });
  await vault.write.deposit([signer.account.address, signer.account.address], {
    account: signer.account,
  });

  return { signer, underlying, asset, vault };
}

describe("OccultaVault", () => {
  it(
    "full deposit lifecycle: request -> approve -> claim, first deposit seeds shares at the virtual-share ratio",
    { timeout: 240_000 },
    async () => {
      const { viem } = await nox.connect();
      // The signer plays depositor, controller AND the vault's agent (owner) — the Nox SDK's
      // decrypt/encrypt calls are bound to `viem.getWalletClients()[0]`, so whoever needs to
      // decrypt a handle in this test must be that account.
      const [signer] = await viem.getWalletClients();
      const { underlying, asset, vault } = await deployVault(viem, signer);

      const balanceHandle = await prepDeposit(asset, vault, underlying, signer, AMOUNT);

      await vault.write.requestDeposit(
        [balanceHandle, signer.account.address, signer.account.address],
        { account: signer.account },
      );

      const pendingHandle = (await vault.read.pendingDepositRequest([
        signer.account.address,
      ])) as `0x${string}`;
      const pending = await decryptAmount(pendingHandle);
      assert.equal(pending, AMOUNT, "pending must equal the requested deposit");

      const supplyBefore = await decryptAmount(
        (await vault.read.confidentialTotalSupply()) as `0x${string}`,
      );
      assert.equal(supplyBefore, 0n, "totalSupply must be 0 before any approval");

      await vault.write.approveDeposit([pendingHandle, signer.account.address], {
        account: signer.account,
      });

      const pendingAfter = await decryptAmount(
        (await vault.read.pendingDepositRequest([signer.account.address])) as `0x${string}`,
      );
      assert.equal(pendingAfter, 0n, "pending must be drained after approval");

      const claimable = await decryptAmount(
        (await vault.read.claimableDepositRequest([signer.account.address])) as `0x${string}`,
      );
      assert.equal(claimable, AMOUNT, "claimable must equal the approved amount");

      const supplyAfter = await decryptAmount(
        (await vault.read.confidentialTotalSupply()) as `0x${string}`,
      );
      assert.equal(
        supplyAfter,
        AMOUNT * SEED_SHARE_MULTIPLIER,
        "first deposit mints assets * 10^decimalsOffset shares",
      );

      const sharesPreClaim = await decryptAmount(
        (await vault.read.confidentialBalanceOf([signer.account.address])) as `0x${string}`,
      );
      assert.equal(sharesPreClaim, 0n, "shares stay escrowed at the vault until claimed");

      await vault.write.deposit([signer.account.address, signer.account.address], {
        account: signer.account,
      });

      const claimableAfterClaim = await decryptAmount(
        (await vault.read.claimableDepositRequest([signer.account.address])) as `0x${string}`,
      );
      assert.equal(claimableAfterClaim, 0n, "claimable bucket must be emptied on claim");

      const sharesPostClaim = await decryptAmount(
        (await vault.read.confidentialBalanceOf([signer.account.address])) as `0x${string}`,
      );
      assert.equal(
        sharesPostClaim,
        AMOUNT * SEED_SHARE_MULTIPLIER,
        "claim transfers the full escrowed share amount to the depositor",
      );
    },
  );

  it(
    "agent-gating: a non-owner cannot call approveDeposit or approveRedeem",
    { timeout: 240_000 },
    async () => {
      const { viem } = await nox.connect();
      const [agent, nonOwner] = await viem.getWalletClients();
      const { vault } = await deployVault(viem, agent);

      await assertRevertsWithError(
        vault.write.approveDeposit([ZERO_HANDLE, nonOwner.account.address], {
          account: nonOwner.account,
        }),
        "OwnableUnauthorizedAccount",
      );
      await assertRevertsWithError(
        vault.write.approveRedeem([ZERO_HANDLE, nonOwner.account.address], {
          account: nonOwner.account,
        }),
        "OwnableUnauthorizedAccount",
      );
    },
  );

  it(
    "privacy: an outsider cannot decrypt another depositor's pending or share handles",
    { timeout: 240_000 },
    async () => {
      const { viem } = await nox.connect();
      const [signer, outsider] = await viem.getWalletClients();
      const { underlying, asset, vault } = await deployVault(viem, signer);

      const balanceHandle = await prepDeposit(asset, vault, underlying, signer, AMOUNT);
      await vault.write.requestDeposit(
        [balanceHandle, signer.account.address, signer.account.address],
        { account: signer.account },
      );

      const pendingHandle = (await vault.read.pendingDepositRequest([
        signer.account.address,
      ])) as `0x${string}`;
      assert.equal(
        await vault.read.isAllowedFor([pendingHandle, signer.account.address]),
        true,
        "depositor must be allowed on their own pending handle",
      );
      assert.equal(
        await vault.read.isAllowedFor([pendingHandle, outsider.account.address]),
        false,
        "outsider must not be allowed on someone else's pending handle",
      );

      await vault.write.approveDeposit([pendingHandle, signer.account.address], {
        account: signer.account,
      });
      await vault.write.deposit([signer.account.address, signer.account.address], {
        account: signer.account,
      });

      const sharesHandle = (await vault.read.confidentialBalanceOf([
        signer.account.address,
      ])) as `0x${string}`;
      assert.equal(
        await vault.read.isAllowedFor([sharesHandle, signer.account.address]),
        true,
        "depositor must be allowed on their own share balance",
      );
      assert.equal(
        await vault.read.isAllowedFor([sharesHandle, outsider.account.address]),
        false,
        "outsider must not be allowed on someone else's share balance",
      );
    },
  );

  it(
    "over-approval is a silent no-op: pending stays intact and nothing is credited",
    { timeout: 240_000 },
    async () => {
      const { viem } = await nox.connect();
      const [signer, richController] = await viem.getWalletClients();
      const { underlying, asset, vault } = await deployVault(viem, signer);

      const SMALL = 1_000_000n;
      const BIG = 50_000_000n;

      // Small pending bucket, the one under test.
      const smallHandle = await prepDeposit(asset, vault, underlying, signer, SMALL);
      await vault.write.requestDeposit(
        [smallHandle, signer.account.address, signer.account.address],
        { account: signer.account },
      );

      // A much larger pending bucket filed under a different controller key, funded by the
      // same depositor. The vault holds persistent Nox ACL on every pending handle it has ever
      // produced, so this handle is a legitimate (if oversized) argument for `approveDeposit`.
      const bigHandle = await prepDeposit(asset, vault, underlying, signer, BIG);
      await vault.write.requestDeposit(
        [bigHandle, richController.account.address, signer.account.address],
        { account: signer.account },
      );
      const richPendingHandle = (await vault.read.pendingDepositRequest([
        richController.account.address,
      ])) as `0x${string}`;

      // Agent attempts to settle the depositor's SMALL bucket using the oversized handle.
      await vault.write.approveDeposit([richPendingHandle, signer.account.address], {
        account: signer.account,
      });

      const pendingAfter = await decryptAmount(
        (await vault.read.pendingDepositRequest([signer.account.address])) as `0x${string}`,
      );
      assert.equal(pendingAfter, SMALL, "over-approval must leave pending untouched");

      const claimableAfter = await decryptAmount(
        (await vault.read.claimableDepositRequest([signer.account.address])) as `0x${string}`,
      );
      assert.equal(claimableAfter, 0n, "over-approval must credit nothing");
    },
  );

  it(
    "redeem lifecycle: request -> approve (totalSupply drops) -> claim returns assets",
    { timeout: 240_000 },
    async () => {
      const { viem } = await nox.connect();
      const { signer, asset, vault } = await setupDepositedVault(viem, AMOUNT);

      const sharesHandle = (await vault.read.confidentialBalanceOf([
        signer.account.address,
      ])) as `0x${string}`;
      const shares = await decryptAmount(sharesHandle);
      assert.equal(shares, AMOUNT * SEED_SHARE_MULTIPLIER);

      // Grant the vault Nox ACL on the shares handle it is about to escrow (parallel to the
      // deposit-side balance-handle grant).
      await signer.writeContract({
        address: NOX_COMPUTE_ADDRESS,
        abi: noxComputeAbi,
        functionName: "allow",
        args: [sharesHandle, vault.address],
      });

      await vault.write.requestRedeem(
        [sharesHandle, signer.account.address, signer.account.address],
        { account: signer.account },
      );

      const pendingRedeem = await decryptAmount(
        (await vault.read.pendingRedeemRequest([signer.account.address])) as `0x${string}`,
      );
      assert.equal(pendingRedeem, shares, "pending redeem must equal the escrowed shares");

      const sharesAfterRequest = await decryptAmount(
        (await vault.read.confidentialBalanceOf([signer.account.address])) as `0x${string}`,
      );
      assert.equal(sharesAfterRequest, 0n, "shares move to the vault at request time");

      const supplyBefore = await decryptAmount(
        (await vault.read.confidentialTotalSupply()) as `0x${string}`,
      );

      const pendingRedeemHandle = (await vault.read.pendingRedeemRequest([
        signer.account.address,
      ])) as `0x${string}`;
      await vault.write.approveRedeem([pendingRedeemHandle, signer.account.address], {
        account: signer.account,
      });

      const supplyAfter = await decryptAmount(
        (await vault.read.confidentialTotalSupply()) as `0x${string}`,
      );
      assert.equal(
        supplyBefore - supplyAfter,
        shares,
        "approveRedeem must burn the escrowed shares immediately",
      );

      const claimableRedeemShares = await decryptAmount(
        (await vault.read.claimableRedeemRequest([signer.account.address])) as `0x${string}`,
      );
      assert.equal(claimableRedeemShares, shares);

      await vault.write.redeem([signer.account.address, signer.account.address], {
        account: signer.account,
      });

      const claimableRedeemAfter = await decryptAmount(
        (await vault.read.claimableRedeemRequest([signer.account.address])) as `0x${string}`,
      );
      assert.equal(claimableRedeemAfter, 0n, "claimable redeem bucket must empty on claim");

      const finalCusdc = await decryptAmount(
        (await asset.read.confidentialBalanceOf([signer.account.address])) as `0x${string}`,
      );
      assert.equal(
        finalCusdc,
        AMOUNT,
        "redeeming all shares must return the originally-deposited underlying amount",
      );
    },
  );

  it(
    "sync ERC-4626 entry points revert: this vault is async-only",
    { timeout: 240_000 },
    async () => {
      const { viem } = await nox.connect();
      const [signer] = await viem.getWalletClients();
      const { vault } = await deployVault(viem, signer);

      await assertRevertsWithError(
        vault.write.deposit([ZERO_HANDLE, "0x", signer.account.address], {
          account: signer.account,
        }),
        "OccultaVaultSyncEntryPointDisabled",
      );
      await assertRevertsWithError(
        vault.write.mint([ZERO_HANDLE, "0x", signer.account.address], {
          account: signer.account,
        }),
        "OccultaVaultSyncEntryPointDisabled",
      );
      await assertRevertsWithError(
        vault.write.withdraw([ZERO_HANDLE, "0x", signer.account.address, signer.account.address], {
          account: signer.account,
        }),
        "OccultaVaultSyncEntryPointDisabled",
      );
      await assertRevertsWithError(
        vault.write.redeem([ZERO_HANDLE, "0x", signer.account.address, signer.account.address], {
          account: signer.account,
        }),
        "OccultaVaultSyncEntryPointDisabled",
      );
    },
  );
});
