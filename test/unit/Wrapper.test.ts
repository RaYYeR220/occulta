import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { nox } from "@iexec-nox/nox-hardhat-plugin";

/** 1 USDC at the real 6-decimal Aave Sepolia USDC scale. */
const AMOUNT = 1_000_000n;

const CONTRACT_URI = "https://occulta.example/ocusdc.json";

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
});
