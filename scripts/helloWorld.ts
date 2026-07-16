import { network } from "hardhat";
import { createViemHandleClient } from "@iexec-nox/handle";
import { formatEther, type Hash } from "viem";

/**
 * The iExec Nox "Hello World" journey (docs.iex.ec/nox-protocol/getting-started/hello-world),
 * run end to end against live ETH Sepolia: deploy the tutorial's ConfidentialPiggyBank
 * (contracts/tutorial/ConfidentialPiggyBank.sol, copied verbatim from the docs), submit one
 * encrypted deposit through the Nox handle gateway, then decrypt the resulting balance back to
 * confirm the whole confidential round trip actually happened on-chain.
 *
 * Usage: pnpm hardhat run scripts/helloWorld.ts --network sepolia
 *
 * Every write is single-shot: a revert stops the script immediately with the reverting tx hash,
 * rather than being retried. Only the final decrypt is retried, and only because handle
 * resolution runs asynchronously behind the gateway — the balance handle minted by the deposit
 * tx that just confirmed is not necessarily computable yet.
 */

const DEPOSIT_AMOUNT = 1000n;

function etherscanTx(hash: string): string {
  return `https://sepolia.etherscan.io/tx/${hash}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withGatewayRetry<T>(
  label: string,
  attempt: () => Promise<T>,
  options: { attempts?: number; delayMs?: number; maxDelayMs?: number } = {},
): Promise<T> {
  const attempts = options.attempts ?? 15;
  const maxDelay = options.maxDelayMs ?? 10_000;
  let delay = options.delayMs ?? 2_000;
  let lastError: unknown;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await attempt();
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      console.log(`    [gateway not ready, retry ${i}/${attempts}] ${label}: ${message}`);
      if (i === attempts) break;
      await sleep(delay);
      delay = Math.min(delay * 1.5, maxDelay);
    }
  }
  throw new Error(
    `${label} did not resolve against the live Nox gateway after ${attempts} attempts. Last error: ` +
      `${lastError instanceof Error ? lastError.message : String(lastError)}`,
  );
}

async function main() {
  const connection = await network.create();
  const { viem, networkName } = connection;
  const [wallet] = await viem.getWalletClients();
  const publicClient = await viem.getPublicClient();
  const chainId = await publicClient.getChainId();

  if (networkName !== "sepolia" || chainId !== 11155111) {
    throw new Error(
      `this journey must run against live ETH Sepolia — got network "${networkName}" (chainId ${chainId})`,
    );
  }

  console.log(`== iExec Nox hello-world journey — ETH Sepolia ==`);
  console.log(`wallet: ${wallet.account.address}`);
  console.log(`ETH balance: ${formatEther(await publicClient.getBalance({ address: wallet.account.address }))} ETH`);

  const txHashes: Record<string, Hash> = {};
  async function sendAndTrack(label: string, hash: Hash) {
    console.log(`  tx: ${label} -> ${hash}`);
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") {
      throw new Error(`${label} REVERTED (tx ${hash}) — see ${etherscanTx(hash)}`);
    }
    txHashes[label] = hash;
    console.log(`    confirmed in block ${receipt.blockNumber}, gasUsed ${receipt.gasUsed} -> ${etherscanTx(hash)}`);
    return receipt;
  }

  console.log(`\n[1] deploy ConfidentialPiggyBank`);
  const { contract: piggyBank, deploymentTransaction } = await viem.sendDeploymentTransaction("ConfidentialPiggyBank");
  const deployReceipt = await sendAndTrack("deploy", deploymentTransaction.hash);
  if (deployReceipt.contractAddress === null || deployReceipt.contractAddress === undefined) {
    throw new Error("deploy receipt has no contractAddress");
  }
  console.log(`  ConfidentialPiggyBank deployed at ${piggyBank.address}`);

  console.log(`\n[2] encrypted deposit of ${DEPOSIT_AMOUNT}`);
  const handleClient = await createViemHandleClient(wallet);
  const { handle, handleProof } = await handleClient.encryptInput(DEPOSIT_AMOUNT, "uint256", piggyBank.address);
  console.log(`  encrypted input handle: ${handle}`);
  await sendAndTrack(
    "deposit",
    await piggyBank.write.deposit([handle, handleProof], { account: wallet.account }),
  );

  console.log(`\n[3] decrypt the piggy bank's balance`);
  const balanceHandle = (await piggyBank.read.balance()) as `0x${string}`;
  console.log(`  balance handle: ${balanceHandle}`);
  const { value: decryptedBalance } = await withGatewayRetry("decrypt(balance)", () =>
    handleClient.decrypt(balanceHandle),
  );
  console.log(`  decrypted balance: ${decryptedBalance}`);
  if (decryptedBalance !== DEPOSIT_AMOUNT) {
    throw new Error(`decrypted balance is ${decryptedBalance}, expected ${DEPOSIT_AMOUNT} — aborting`);
  }

  console.log(`\n== journey complete ==`);
  console.log(`wallet:              ${wallet.account.address}`);
  console.log(`ConfidentialPiggyBank: ${piggyBank.address}`);
  console.log(`deploy tx:           ${txHashes.deploy} -> ${etherscanTx(txHashes.deploy!)}`);
  console.log(`deposit tx:          ${txHashes.deposit} -> ${etherscanTx(txHashes.deposit!)}`);
  console.log(`decrypted balance:   ${decryptedBalance}`);
}

main().catch((err) => {
  console.error(`\nhelloWorld.ts failed:`);
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
