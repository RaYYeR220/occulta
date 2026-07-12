import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { nox } from "@iexec-nox/nox-hardhat-plugin";

/** 1 USDC at the real 6-decimal Aave Sepolia USDC scale. */
const AMOUNT = 1_000_000n;

const CONTRACT_URI = "https://occulta.example/ocusdc.json";

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

/** Deploys a fresh mock underlying + wrapper pair, wired together like the real deployment. */
async function deployWrapper(viem: Awaited<ReturnType<typeof nox.connect>>["viem"]) {
  const underlying = await viem.deployContract("MockUSDC");
  const wrapper = await viem.deployContract("OccultaUSDC", [
    underlying.address,
    "Occulta USDC",
    "ocUSDC",
    CONTRACT_URI,
  ]);
  return { underlying, wrapper };
}

describe("OccultaUSDC wrapper", () => {
  it(
    "wraps plaintext USDC into a confidential balance only the owner can decrypt",
    { timeout: 180_000 },
    async () => {
      const { viem } = await nox.connect();
      // `nox.decrypt`/`nox.publicDecrypt` are bound to the network connection's first
      // signer, so that account plays the depositor here; the second account is a
      // pure outsider used only for the negative ACL assertion below.
      const [user, outsider] = await viem.getWalletClients();

      const { underlying, wrapper } = await deployWrapper(viem);

      // Decimals sanity: 6-decimal underlying, no silent scaling in the wrapper.
      assert.equal(await underlying.read.decimals(), 6);
      assert.equal(await wrapper.read.decimals(), 6);
      assert.equal(
        (await wrapper.read.underlying() as string).toLowerCase(),
        underlying.address.toLowerCase(),
      );

      await underlying.write.mint([user.account.address, AMOUNT]);
      await underlying.write.approve([wrapper.address, AMOUNT], { account: user.account });

      await wrapper.write.wrap([user.account.address, AMOUNT], { account: user.account });

      // The plaintext ERC-20 moved out of the depositor and into the wrapper.
      assert.equal(await underlying.read.balanceOf([wrapper.address]), AMOUNT);
      assert.equal(await underlying.read.balanceOf([user.account.address]), 0n);

      const balanceHandle = (await wrapper.read.confidentialBalanceOf([
        user.account.address,
      ])) as `0x${string}`;

      const { value: balance } = await nox.decrypt(balanceHandle);
      assert.equal(balance, AMOUNT);

      // Privacy: the depositor can decrypt their own balance, an outsider cannot.
      assert.equal(
        await wrapper.read.isAllowedFor([balanceHandle, user.account.address]),
        true,
      );
      assert.equal(
        await wrapper.read.isAllowedFor([balanceHandle, outsider.account.address]),
        false,
      );
    },
  );

  it(
    "bridges an unwrap request through publicDecrypt back to plaintext USDC",
    { timeout: 180_000 },
    async () => {
      const { viem } = await nox.connect();
      const publicClient = await viem.getPublicClient();
      const [user, finalizer] = await viem.getWalletClients();

      const { underlying, wrapper } = await deployWrapper(viem);

      await underlying.write.mint([user.account.address, AMOUNT]);
      await underlying.write.approve([wrapper.address, AMOUNT], { account: user.account });
      await wrapper.write.wrap([user.account.address, AMOUNT], { account: user.account });

      const { handle: encHandle, handleProof } = await nox.encryptInput(
        AMOUNT,
        "uint256",
        wrapper.address,
      );

      const unwrapHash = await wrapper.write.unwrap(
        [user.account.address, user.account.address, encHandle, handleProof],
        { account: user.account },
      );
      const unwrapReceipt = await publicClient.waitForTransactionReceipt({ hash: unwrapHash });

      const requestedEvents = await wrapper.getEvents.UnwrapRequested(
        {},
        { fromBlock: unwrapReceipt.blockNumber, toBlock: unwrapReceipt.blockNumber },
      );
      assert.equal(requestedEvents.length, 1);
      const unwrapRequestId = requestedEvents[0].args.amount as `0x${string}`;
      assert.equal(
        (requestedEvents[0].args.receiver as string).toLowerCase(),
        user.account.address.toLowerCase(),
      );

      // The burn already happened at request time: the confidential balance is gone.
      const postRequestHandle = (await wrapper.read.confidentialBalanceOf([
        user.account.address,
      ])) as `0x${string}`;
      const { value: postRequestBalance } = await nox.decrypt(postRequestHandle);
      assert.equal(postRequestBalance, 0n);

      assert.equal(
        (await wrapper.read.unwrapRequester([unwrapRequestId]) as string).toLowerCase(),
        user.account.address.toLowerCase(),
      );

      // The bridge: the requested amount is now public, and resolves to the exact plaintext.
      const { value: plaintext, decryptionProof } = await nox.publicDecrypt(unwrapRequestId);
      assert.equal(plaintext, AMOUNT);

      // Anyone can carry the proof across the bridge — finalization is proof-gated, not caller-gated.
      await wrapper.write.finalizeUnwrap([unwrapRequestId, decryptionProof], {
        account: finalizer.account,
      });

      assert.equal(await underlying.read.balanceOf([user.account.address]), AMOUNT);
      assert.equal(await underlying.read.balanceOf([wrapper.address]), 0n);
      assert.equal(
        await wrapper.read.unwrapRequester([unwrapRequestId]),
        "0x0000000000000000000000000000000000000000",
      );
    },
  );

  it(
    "rejects an unwrap attempt from a caller who is neither the balance owner nor an approved operator",
    { timeout: 180_000 },
    async () => {
      const { viem } = await nox.connect();
      // `nox.encryptInput`'s proof binds its `owner` field to account 0 (the connection's
      // first signer — see the handle client's doc comment), and the base contract's
      // `Nox.fromExternal` requires `msg.sender` to equal that bound owner (checked in
      // `Compute.validateInputProof` as "Owner mismatch") before the request even reaches
      // `_unwrap`'s `from == msg.sender || isOperator(from, msg.sender)` gate. So account 0
      // has to submit the transaction (playing the attacker) for the proof to clear that
      // earlier gate and actually exercise the authorization check under test; the victim
      // being drained is a separate, distinct account.
      const [attacker, victim] = await viem.getWalletClients();

      const { underlying, wrapper } = await deployWrapper(viem);

      await underlying.write.mint([victim.account.address, AMOUNT]);
      await underlying.write.approve([wrapper.address, AMOUNT], { account: victim.account });
      await wrapper.write.wrap([victim.account.address, AMOUNT], { account: victim.account });

      const balanceHandleBefore = await wrapper.read.confidentialBalanceOf([
        victim.account.address,
      ]);

      const { handle: encHandle, handleProof } = await nox.encryptInput(
        AMOUNT,
        "uint256",
        wrapper.address,
      );

      // Real base error: `ERC7984UnauthorizedSpender(address holder, address spender)`,
      // raised by `ERC20ToERC7984WrapperBase._unwrap`.
      await assertRevertsWithError(
        wrapper.write.unwrap(
          [victim.account.address, attacker.account.address, encHandle, handleProof],
          { account: attacker.account },
        ),
        "ERC7984UnauthorizedSpender",
      );

      // The whole call reverted: victim's confidential balance handle is untouched (no
      // burn ever ran) and no plaintext USDC moved anywhere.
      assert.equal(
        await wrapper.read.confidentialBalanceOf([victim.account.address]),
        balanceHandleBefore,
      );
      assert.equal(await underlying.read.balanceOf([wrapper.address]), AMOUNT);
      assert.equal(await underlying.read.balanceOf([victim.account.address]), 0n);
    },
  );

  it(
    "clamps an over-unwrap request to encrypted zero instead of reverting or releasing real funds",
    { timeout: 180_000 },
    async () => {
      const { viem } = await nox.connect();
      const publicClient = await viem.getPublicClient();
      const [user, finalizer] = await viem.getWalletClients();

      const { underlying, wrapper } = await deployWrapper(viem);

      await underlying.write.mint([user.account.address, AMOUNT]);
      await underlying.write.approve([wrapper.address, AMOUNT], { account: user.account });
      await wrapper.write.wrap([user.account.address, AMOUNT], { account: user.account });

      // Request far more than the confidential balance actually holds.
      const OVER_AMOUNT = AMOUNT * 10n;
      const { handle: encHandle, handleProof } = await nox.encryptInput(
        OVER_AMOUNT,
        "uint256",
        wrapper.address,
      );

      // Must NOT revert: `Nox.burn` computes success homomorphically and
      // `_updateWithOptimizedPrimitives` folds the transferred amount to encrypted zero via
      // `Nox.select` rather than reverting. A revert here would leak "insufficient balance"
      // through a plaintext-visible transaction failure — exactly the side channel this
      // design avoids.
      const unwrapHash = await wrapper.write.unwrap(
        [user.account.address, user.account.address, encHandle, handleProof],
        { account: user.account },
      );
      const unwrapReceipt = await publicClient.waitForTransactionReceipt({ hash: unwrapHash });

      const requestedEvents = await wrapper.getEvents.UnwrapRequested(
        {},
        { fromBlock: unwrapReceipt.blockNumber, toBlock: unwrapReceipt.blockNumber },
      );
      assert.equal(requestedEvents.length, 1);
      const unwrapRequestId = requestedEvents[0].args.amount as `0x${string}`;

      // The confidential balance is untouched: the homomorphic burn's success flag was
      // false, so the recorded balance is unchanged.
      const balanceHandle = (await wrapper.read.confidentialBalanceOf([
        user.account.address,
      ])) as `0x${string}`;
      const { value: balanceAfter } = await nox.decrypt(balanceHandle);
      assert.equal(balanceAfter, AMOUNT);

      // The disclosed request amount is clamped to zero, not the requested over-amount.
      const { value: disclosedAmount, decryptionProof } =
        await nox.publicDecrypt(unwrapRequestId);
      assert.equal(disclosedAmount, 0n);

      // Finalizing the (zero) request must not release any plaintext USDC.
      await wrapper.write.finalizeUnwrap([unwrapRequestId, decryptionProof], {
        account: finalizer.account,
      });

      assert.equal(await underlying.read.balanceOf([user.account.address]), 0n);
      assert.equal(await underlying.read.balanceOf([wrapper.address]), AMOUNT);
    },
  );

  it(
    "rejects a repeated finalizeUnwrap call for an already-finalized request",
    { timeout: 180_000 },
    async () => {
      const { viem } = await nox.connect();
      const publicClient = await viem.getPublicClient();
      const [user, finalizer] = await viem.getWalletClients();

      const { underlying, wrapper } = await deployWrapper(viem);

      await underlying.write.mint([user.account.address, AMOUNT]);
      await underlying.write.approve([wrapper.address, AMOUNT], { account: user.account });
      await wrapper.write.wrap([user.account.address, AMOUNT], { account: user.account });

      const { handle: encHandle, handleProof } = await nox.encryptInput(
        AMOUNT,
        "uint256",
        wrapper.address,
      );

      const unwrapHash = await wrapper.write.unwrap(
        [user.account.address, user.account.address, encHandle, handleProof],
        { account: user.account },
      );
      const unwrapReceipt = await publicClient.waitForTransactionReceipt({ hash: unwrapHash });

      const requestedEvents = await wrapper.getEvents.UnwrapRequested(
        {},
        { fromBlock: unwrapReceipt.blockNumber, toBlock: unwrapReceipt.blockNumber },
      );
      const unwrapRequestId = requestedEvents[0].args.amount as `0x${string}`;

      const { decryptionProof } = await nox.publicDecrypt(unwrapRequestId);

      await wrapper.write.finalizeUnwrap([unwrapRequestId, decryptionProof], {
        account: finalizer.account,
      });
      assert.equal(await underlying.read.balanceOf([user.account.address]), AMOUNT);

      // The base contract deletes `_unwrapRequests[unwrapRequestId]` on first finalize, so
      // `unwrapRequester` resets to `address(0)` and a replay must hit
      // `InvalidUnwrapRequest(euint256 unwrapRequestId)`, not silently pay out again.
      assert.equal(
        await wrapper.read.unwrapRequester([unwrapRequestId]),
        "0x0000000000000000000000000000000000000000",
      );
      await assertRevertsWithError(
        wrapper.write.finalizeUnwrap([unwrapRequestId, decryptionProof], {
          account: finalizer.account,
        }),
        "InvalidUnwrapRequest",
      );

      // No second payout.
      assert.equal(await underlying.read.balanceOf([user.account.address]), AMOUNT);
      assert.equal(await underlying.read.balanceOf([wrapper.address]), 0n);
    },
  );
});
