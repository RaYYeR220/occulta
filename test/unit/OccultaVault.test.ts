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

type Viem = Awaited<ReturnType<typeof nox.connect>>["viem"];
type Wallet = Awaited<ReturnType<Viem["getWalletClients"]>>[number];

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

type Stack = Awaited<ReturnType<typeof deployVault>>;

/** Grants `to` Nox ACL access on `handle`, acting as `from` — who must already be allowed on it. */
async function grantHandle(from: Wallet, handle: `0x${string}`, to: `0x${string}`) {
  await from.writeContract({
    address: NOX_COMPUTE_ADDRESS,
    abi: noxComputeAbi,
    functionName: "allow",
    args: [handle, to],
  });
}

/**
 * Decrypts a handle owned by someone other than account 0. `nox.decrypt` is bound to
 * `viem.getWalletClients()[0]`, so `holder` first grants that account (`decrypter`, the agent in
 * the multi-party tests) Nox ACL access on the handle. The value itself is genuinely decrypted.
 */
async function decryptAs(holder: Wallet, decrypter: Wallet, handle: `0x${string}`): Promise<bigint> {
  if (handle === ZERO_HANDLE) return 0n;
  await grantHandle(holder, handle, decrypter.account.address);
  return decryptAmount(handle);
}

/** Full deposit lifecycle for `depositor` on an `agent`-owned vault: request -> approve -> claim. */
async function depositAndClaim(stack: Stack, agent: Wallet, depositor: Wallet, amount: bigint) {
  const { underlying, asset, vault } = stack;
  const balanceHandle = await prepDeposit(asset, vault, underlying, depositor, amount);
  await vault.write.requestDeposit(
    [balanceHandle, depositor.account.address, depositor.account.address],
    { account: depositor.account },
  );
  const pendingHandle = (await vault.read.pendingDepositRequest([
    depositor.account.address,
  ])) as `0x${string}`;
  await vault.write.approveDeposit([pendingHandle, depositor.account.address], {
    account: agent.account,
  });
  await vault.write.deposit([depositor.account.address, depositor.account.address], {
    account: depositor.account,
  });
}

/** Escrows `holder`'s entire share balance into a pending redeem request. */
async function requestFullRedeem(stack: Stack, holder: Wallet) {
  const { vault } = stack;
  const sharesHandle = (await vault.read.confidentialBalanceOf([
    holder.account.address,
  ])) as `0x${string}`;
  await grantHandle(holder, sharesHandle, vault.address);
  await vault.write.requestRedeem(
    [sharesHandle, holder.account.address, holder.account.address],
    { account: holder.account },
  );
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
    "two depositors, one redeem batch: Bob's settlement must not be priced against the assets already reserved for Alice",
    { timeout: 240_000 },
    async () => {
      const { viem } = await nox.connect();
      // Account 0 is the AGENT here: `nox.decrypt` binds to `getWalletClients()[0]`, and the
      // vault grants `owner()` persistent ACL on every pending/claimable bucket and on both
      // totals — so the agent can genuinely read BOTH depositors' handles.
      const [agent, alice, bob] = await viem.getWalletClients();
      const stack = await deployVault(viem, agent);
      const { asset, vault } = stack;

      await depositAndClaim(stack, agent, alice, AMOUNT);
      await depositAndClaim(stack, agent, bob, AMOUNT);

      const assetsBefore = await decryptAmount(
        (await vault.read.confidentialTotalAssets()) as `0x${string}`,
      );
      assert.equal(assetsBefore, 2n * AMOUNT, "the vault holds both deposits");
      const supplyBefore = await decryptAmount(
        (await vault.read.confidentialTotalSupply()) as `0x${string}`,
      );
      assert.equal(
        supplyBefore,
        2n * AMOUNT * SEED_SHARE_MULTIPLIER,
        "both depositors minted at the same price — each owns half the vault",
      );

      await requestFullRedeem(stack, alice);
      await requestFullRedeem(stack, bob);

      // The agent settles the batch: Alice, then Bob. Neither has claimed yet — this is the
      // ordinary operating pattern (settle in a batch, users claim whenever), not a race.
      const alicePending = (await vault.read.pendingRedeemRequest([
        alice.account.address,
      ])) as `0x${string}`;
      await vault.write.approveRedeem([alicePending, alice.account.address], {
        account: agent.account,
      });
      const bobPending = (await vault.read.pendingRedeemRequest([
        bob.account.address,
      ])) as `0x${string}`;
      await vault.write.approveRedeem([bobPending, bob.account.address], {
        account: agent.account,
      });

      const aliceReserved = await decryptAmount(
        (await vault.read.claimableRedeemAssets([alice.account.address])) as `0x${string}`,
      );
      const bobReserved = await decryptAmount(
        (await vault.read.claimableRedeemAssets([bob.account.address])) as `0x${string}`,
      );

      assert.equal(aliceReserved, AMOUNT, "Alice is reserved her half of the vault");
      assert.equal(
        bobReserved,
        AMOUNT,
        "Bob holds half the shares, so he is owed half the assets: his NAV must exclude the " +
          "assets already reserved for Alice's approved-but-unclaimed redeem",
      );

      const vaultAssets = await decryptAmount(
        (await vault.read.confidentialTotalAssets()) as `0x${string}`,
      );
      assert.ok(
        aliceReserved + bobReserved <= vaultAssets,
        `vault is insolvent: ${aliceReserved + bobReserved} reserved against a balance of ${vaultAssets}`,
      );

      // Bob (settled second) claims first. Against an overstated NAV he would drain the vault and
      // Alice's `_transferOut` would silently clamp to encrypted zero — destroying her claim.
      await vault.write.redeem([bob.account.address, bob.account.address], {
        account: bob.account,
      });
      await vault.write.redeem([alice.account.address, alice.account.address], {
        account: alice.account,
      });

      const bobAssets = await decryptAs(
        bob,
        agent,
        (await asset.read.confidentialBalanceOf([bob.account.address])) as `0x${string}`,
      );
      const aliceAssets = await decryptAs(
        alice,
        agent,
        (await asset.read.confidentialBalanceOf([alice.account.address])) as `0x${string}`,
      );
      assert.equal(bobAssets, AMOUNT, "Bob is paid out in full");
      assert.equal(aliceAssets, AMOUNT, "Alice is paid out in full — not a silently-clamped zero");
    },
  );

  it(
    "deposit after an approved-but-unclaimed redeem: the new depositor must not be diluted by the reserved assets",
    { timeout: 240_000 },
    async () => {
      const { viem } = await nox.connect();
      const [agent, alice, bob, carol] = await viem.getWalletClients();
      const stack = await deployVault(viem, agent);
      const { underlying, asset, vault } = stack;

      await depositAndClaim(stack, agent, alice, AMOUNT);
      await depositAndClaim(stack, agent, bob, AMOUNT);

      // Alice's redeem is approved — her shares are burned and AMOUNT of assets is earmarked for
      // her — but she has not claimed, so those assets still sit in the vault's balance.
      await requestFullRedeem(stack, alice);
      const alicePending = (await vault.read.pendingRedeemRequest([
        alice.account.address,
      ])) as `0x${string}`;
      await vault.write.approveRedeem([alicePending, alice.account.address], {
        account: agent.account,
      });

      const supplyBefore = await decryptAmount(
        (await vault.read.confidentialTotalSupply()) as `0x${string}`,
      );
      assert.equal(
        supplyBefore,
        AMOUNT * SEED_SHARE_MULTIPLIER,
        "only Bob's shares are left outstanding",
      );
      assert.equal(
        await decryptAmount(
          (await vault.read.claimableRedeemAssets([alice.account.address])) as `0x${string}`,
        ),
        AMOUNT,
        "Alice's assets are reserved but still counted in the vault's balance",
      );

      // Carol enters. Productive capital = Bob's AMOUNT: Alice's AMOUNT is spoken for and Carol's
      // own AMOUNT is still pending. She must therefore mint exactly what Bob holds.
      const carolHandle = await prepDeposit(asset, vault, underlying, carol, AMOUNT);
      await vault.write.requestDeposit(
        [carolHandle, carol.account.address, carol.account.address],
        { account: carol.account },
      );
      const carolPending = (await vault.read.pendingDepositRequest([
        carol.account.address,
      ])) as `0x${string}`;
      await vault.write.approveDeposit([carolPending, carol.account.address], {
        account: agent.account,
      });

      const supplyAfter = await decryptAmount(
        (await vault.read.confidentialTotalSupply()) as `0x${string}`,
      );
      assert.equal(
        supplyAfter - supplyBefore,
        AMOUNT * SEED_SHARE_MULTIPLIER,
        "Carol must mint at par with Bob — pricing her against Alice's reserved assets would " +
          "double the apparent NAV and halve her entry",
      );

      await vault.write.deposit([carol.account.address, carol.account.address], {
        account: carol.account,
      });
      const carolShares = await decryptAs(
        carol,
        agent,
        (await vault.read.confidentialBalanceOf([carol.account.address])) as `0x${string}`,
      );
      assert.equal(
        carolShares,
        AMOUNT * SEED_SHARE_MULTIPLIER,
        "Carol claims the full, fair share amount",
      );
    },
  );

  it(
    "claim-path authorization: a third party cannot claim another controller's deposit or redeem bucket",
    { timeout: 240_000 },
    async () => {
      const { viem } = await nox.connect();
      const [agent, alice, mallory] = await viem.getWalletClients();
      const stack = await deployVault(viem, agent);
      const { underlying, asset, vault } = stack;

      const balanceHandle = await prepDeposit(asset, vault, underlying, alice, AMOUNT);
      await vault.write.requestDeposit(
        [balanceHandle, alice.account.address, alice.account.address],
        { account: alice.account },
      );
      const pendingDeposit = (await vault.read.pendingDepositRequest([
        alice.account.address,
      ])) as `0x${string}`;
      await vault.write.approveDeposit([pendingDeposit, alice.account.address], {
        account: agent.account,
      });

      // Mallory tries to redirect Alice's escrowed shares to himself.
      await assertRevertsWithError(
        vault.write.deposit([mallory.account.address, alice.account.address], {
          account: mallory.account,
        }),
        "ERC7984UnauthorizedSpender",
      );
      assert.equal(
        await decryptAmount(
          (await vault.read.claimableDepositRequest([alice.account.address])) as `0x${string}`,
        ),
        AMOUNT,
        "Alice's claimable deposit bucket survives the attempt",
      );

      await vault.write.deposit([alice.account.address, alice.account.address], {
        account: alice.account,
      });
      await requestFullRedeem(stack, alice);
      const pendingRedeem = (await vault.read.pendingRedeemRequest([
        alice.account.address,
      ])) as `0x${string}`;
      await vault.write.approveRedeem([pendingRedeem, alice.account.address], {
        account: agent.account,
      });

      // ...and to drain the assets reserved for her redeem.
      await assertRevertsWithError(
        vault.write.redeem([mallory.account.address, alice.account.address], {
          account: mallory.account,
        }),
        "ERC7984UnauthorizedSpender",
      );
      assert.equal(
        await decryptAmount(
          (await vault.read.claimableRedeemAssets([alice.account.address])) as `0x${string}`,
        ),
        AMOUNT,
        "Alice's reserved assets survive the attempt",
      );
      assert.equal(
        await decryptAmount(
          (await asset.read.confidentialBalanceOf([mallory.account.address])) as `0x${string}`,
        ),
        0n,
        "Mallory received nothing",
      );

      await vault.write.redeem([alice.account.address, alice.account.address], {
        account: alice.account,
      });
      assert.equal(
        await decryptAs(
          alice,
          agent,
          (await asset.read.confidentialBalanceOf([alice.account.address])) as `0x${string}`,
        ),
        AMOUNT,
        "Alice can still claim her own bucket afterwards",
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

  it(
    "cancelDeposit: pending assets return to the controller, buckets/counter zero, NAV invariant holds",
    { timeout: 240_000 },
    async () => {
      const { viem } = await nox.connect();
      const [signer] = await viem.getWalletClients();
      const { underlying, asset, vault } = await deployVault(viem, signer);

      const balanceHandle = await prepDeposit(asset, vault, underlying, signer, AMOUNT);
      await vault.write.requestDeposit(
        [balanceHandle, signer.account.address, signer.account.address],
        { account: signer.account },
      );

      // Post-request: the assets sit in the vault, the depositor's confidential balance is drained.
      assert.equal(
        await decryptAmount(
          (await asset.read.confidentialBalanceOf([signer.account.address])) as `0x${string}`,
        ),
        0n,
        "the depositor's assets moved into the vault at request time",
      );

      await vault.write.cancelDeposit([signer.account.address], { account: signer.account });

      // The pending assets came back to the controller...
      assert.equal(
        await decryptAmount(
          (await asset.read.confidentialBalanceOf([signer.account.address])) as `0x${string}`,
        ),
        AMOUNT,
        "cancel returns the full pending deposit to the controller",
      );
      // ...the pending bucket and the global inflight counter are both zeroed...
      assert.equal(
        await decryptAmount(
          (await vault.read.pendingDepositRequest([signer.account.address])) as `0x${string}`,
        ),
        0n,
        "the pending deposit bucket is emptied",
      );
      assert.equal(
        await decryptAmount(
          (await vault.read.totalPendingDepositAssets()) as `0x${string}`,
        ),
        0n,
        "the global inflight counter is decremented by the cancelled amount",
      );

      // ...and the NAV invariant survives the cancel.
      const totalAssets = await decryptAmount(
        (await vault.read.confidentialTotalAssets()) as `0x${string}`,
      );
      const totalPending = await decryptAmount(
        (await vault.read.totalPendingDepositAssets()) as `0x${string}`,
      );
      const totalClaimableRedeem = await decryptAmount(
        (await vault.read.totalClaimableRedeemAssets()) as `0x${string}`,
      );
      assert.ok(
        totalAssets >= totalPending + totalClaimableRedeem,
        `NAV invariant broken: assets ${totalAssets} < pending ${totalPending} + claimableRedeem ${totalClaimableRedeem}`,
      );
    },
  );

  it(
    "cancelDeposit cannot pull an already-approved (claimable) bucket",
    { timeout: 240_000 },
    async () => {
      const { viem } = await nox.connect();
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
      await vault.write.approveDeposit([pendingHandle, signer.account.address], {
        account: signer.account,
      });

      // Pending is now zero and the assets are productive (claimable). A cancel must be a no-op
      // on the claimable bucket — it may only ever touch pending.
      await vault.write.cancelDeposit([signer.account.address], { account: signer.account });

      assert.equal(
        await decryptAmount(
          (await vault.read.claimableDepositRequest([signer.account.address])) as `0x${string}`,
        ),
        AMOUNT,
        "the approved/claimable bucket must survive a cancel untouched",
      );
      assert.equal(
        await decryptAmount(
          (await asset.read.confidentialBalanceOf([signer.account.address])) as `0x${string}`,
        ),
        0n,
        "cancel must not return approved funds — pending was already empty",
      );

      // The claim still works: the depositor gets exactly the shares approveDeposit minted.
      await vault.write.deposit([signer.account.address, signer.account.address], {
        account: signer.account,
      });
      assert.equal(
        await decryptAmount(
          (await vault.read.confidentialBalanceOf([signer.account.address])) as `0x${string}`,
        ),
        AMOUNT * SEED_SHARE_MULTIPLIER,
        "the approved deposit is still fully claimable after a cancel",
      );
    },
  );

  it(
    "cancelRedeem: escrowed shares return to the controller, pending redeem zeroed, NAV invariant holds",
    { timeout: 240_000 },
    async () => {
      const { viem } = await nox.connect();
      const { signer, vault } = await setupDepositedVault(viem, AMOUNT);

      const sharesHandle = (await vault.read.confidentialBalanceOf([
        signer.account.address,
      ])) as `0x${string}`;
      const shares = await decryptAmount(sharesHandle);
      assert.equal(shares, AMOUNT * SEED_SHARE_MULTIPLIER);

      await grantHandle(signer, sharesHandle, vault.address);
      await vault.write.requestRedeem(
        [sharesHandle, signer.account.address, signer.account.address],
        { account: signer.account },
      );

      // Escrowed: the shares now sit at the vault, the pending redeem bucket holds them.
      assert.equal(
        await decryptAmount(
          (await vault.read.confidentialBalanceOf([signer.account.address])) as `0x${string}`,
        ),
        0n,
        "shares moved into the vault at redeem-request time",
      );

      await vault.write.cancelRedeem([signer.account.address], { account: signer.account });

      // The escrowed shares came back...
      assert.equal(
        await decryptAmount(
          (await vault.read.confidentialBalanceOf([signer.account.address])) as `0x${string}`,
        ),
        shares,
        "cancel returns the full escrowed share amount to the controller",
      );
      // ...the pending redeem bucket is empty, and the claimable redeem bucket was never touched.
      assert.equal(
        await decryptAmount(
          (await vault.read.pendingRedeemRequest([signer.account.address])) as `0x${string}`,
        ),
        0n,
        "the pending redeem bucket is emptied",
      );
      assert.equal(
        await decryptAmount(
          (await vault.read.claimableRedeemRequest([signer.account.address])) as `0x${string}`,
        ),
        0n,
        "no claimable redeem bucket was created or drained",
      );

      const totalAssets = await decryptAmount(
        (await vault.read.confidentialTotalAssets()) as `0x${string}`,
      );
      const totalPending = await decryptAmount(
        (await vault.read.totalPendingDepositAssets()) as `0x${string}`,
      );
      const totalClaimableRedeem = await decryptAmount(
        (await vault.read.totalClaimableRedeemAssets()) as `0x${string}`,
      );
      assert.ok(
        totalAssets >= totalPending + totalClaimableRedeem,
        `NAV invariant broken: assets ${totalAssets} < pending ${totalPending} + claimableRedeem ${totalClaimableRedeem}`,
      );
    },
  );

  it(
    "cancel authorization: a third party cannot cancel another controller's deposit or redeem",
    { timeout: 240_000 },
    async () => {
      const { viem } = await nox.connect();
      const [agent, alice, mallory] = await viem.getWalletClients();
      const stack = await deployVault(viem, agent);
      const { underlying, asset, vault } = stack;

      // Alice files a pending deposit; Mallory tries to cancel it and claw the assets.
      const balanceHandle = await prepDeposit(asset, vault, underlying, alice, AMOUNT);
      await vault.write.requestDeposit(
        [balanceHandle, alice.account.address, alice.account.address],
        { account: alice.account },
      );
      await assertRevertsWithError(
        vault.write.cancelDeposit([alice.account.address], { account: mallory.account }),
        "ERC7984UnauthorizedSpender",
      );
      assert.equal(
        await decryptAs(
          alice,
          agent,
          (await vault.read.pendingDepositRequest([alice.account.address])) as `0x${string}`,
        ),
        AMOUNT,
        "Alice's pending deposit survives the unauthorized cancel",
      );

      // Alice completes the deposit and files a pending redeem; Mallory tries to cancel that too.
      await vault.write.approveDeposit(
        [(await vault.read.pendingDepositRequest([alice.account.address])) as `0x${string}`, alice.account.address],
        { account: agent.account },
      );
      await vault.write.deposit([alice.account.address, alice.account.address], {
        account: alice.account,
      });
      await requestFullRedeem(stack, alice);
      await assertRevertsWithError(
        vault.write.cancelRedeem([alice.account.address], { account: mallory.account }),
        "ERC7984UnauthorizedSpender",
      );
      assert.ok(
        (await decryptAs(
          alice,
          agent,
          (await vault.read.pendingRedeemRequest([alice.account.address])) as `0x${string}`,
        )) > 0n,
        "Alice's pending redeem survives the unauthorized cancel",
      );
    },
  );
});
