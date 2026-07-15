import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { network } from "hardhat";
import { createViemHandleClient } from "@iexec-nox/handle";
import {
  formatEther,
  getAddress,
  getContractAddress,
  keccak256,
  toHex,
  type Address,
  type Hash,
} from "viem";

import { seedPool, type SeedPoolResult } from "./seedPool.js";

/**
 * Task 10b — the full Occulta deploy: stands up every Task 1-10a contract on ETH Sepolia in the
 * one safe order the security audit requires (see the module-level notes below on the
 * NetSettler/OccultaExecutor circular-immutable problem), wires ownership, runs every
 * post-wiring assertion the audit called for, seeds the Aave-USDC/Aave-WETH Uniswap pool
 * (reusing scripts/seedPool.ts's logic verbatim — see {seedPool}), and writes one comprehensive,
 * non-secret deployment artifact to deployments/<network>.json.
 *
 * Usage:
 *   pnpm deploy:fork    -> hardhat run scripts/deploy.ts --network sepoliaFork (EDR fork, verification)
 *   pnpm deploy:sepolia -> hardhat run scripts/deploy.ts --network sepolia     (live — a LATER task)
 *
 * ============================================================================================
 * The circular-immutable problem, and the deploy order that resolves it.
 * ============================================================================================
 * {OccultaExecutor-settler} and {NetSettler-executor} are both `immutable`, and each contract's
 * constructor takes the other's address. Neither can be deployed first without a value for a
 * field that does not exist yet. This script breaks the cycle by PRE-COMPUTING NetSettler's
 * deployment address before NetSettler exists: a plain (non-CREATE2) contract deployment's
 * address is a pure function of `(sender, sender's nonce at that deployment)`, so once this
 * deployer's CURRENT nonce is known, the very next nonce after OccultaExecutor's own deployment
 * — NetSettler's, deployed immediately afterward with no other transaction from this deployer in
 * between — is predictable via `viem.getContractAddress`. OccultaExecutor is then constructed
 * with that PREDICTED address as its `settler`, NetSettler is deployed right after, and this
 * script asserts the two addresses actually match before doing anything else — aborting loudly,
 * not silently, if they ever diverge (which would only happen if some other transaction from
 * this deployer slipped in between the two deployments and consumed the predicted nonce).
 *
 * ============================================================================================
 * Fork vs. live: the confidential policy-encryption step.
 * ============================================================================================
 * {StrategyRegistry-registerAgent} takes an `externalEuint256[]` policy — there is no on-chain
 * path to register an agent without ENCRYPTED policy slots, so this script cannot skip talking
 * to the Nox handle gateway if it wants a real `agentId` to exist at all.
 *
 * The concern this repo's brief raises is real but narrower than it first looks: the live Nox
 * gateway "does not see a fork's state" applies to RESOLUTION — the gateway's background indexer
 * watching real Sepolia for a handle's creation event, which lets it later serve a `decrypt` /
 * `publicDecrypt` request. This script never decrypts anything it registers, so resolution is
 * never on its critical path. `encryptInput` itself is a stateless request/response against the
 * gateway (client sends plaintext + target contract address over HTTPS, the gateway returns a
 * signed handle + proof) that does not require the gateway to have observed any chain state —
 * verified empirically against `sepoliaFork` during development of this script (a real
 * `encryptInput` call plus a real on-chain `registerAgent` against the fork's forked, genuine
 * NoxCompute deployment both succeeded, because that forked NoxCompute already trusts the same
 * gateway signing key live Sepolia does).
 *
 * Even so, this step reaches out to a live, third-party network service the rest of this script
 * does not depend on, so it is wrapped in a bounded timeout and never allowed to hang the run:
 *   - On `sepolia` (live): required. A timeout or gateway error aborts the whole deploy loudly —
 *     a real deployment with no registered agent is a broken deployment, not a partial success.
 *   - On any other network (`sepoliaFork` included): best-effort. A timeout or gateway error is
 *     logged clearly and the run continues with no `agentId` — every other step (3-12) still
 *     runs and every wiring assertion that does not depend on an agent still executes. The one
 *     assertion that DOES need an agentId (`registry.metaOf(agentId)...`) is skipped and called
 *     out explicitly in both the console output and the written artifact.
 */

// ---------------------------------------------------------------------------------------------
// Verified live addresses on ETH Sepolia (chainId 11155111) — the same ones scripts/seedPool.ts
// and test/integration/Executor.fork.test.ts already use. Duplicated here rather than imported,
// matching this repo's existing convention (see Executor.fork.test.ts's own header) of keeping
// each entrypoint's verified constants self-contained and independently auditable.
// ---------------------------------------------------------------------------------------------
const AAVE_POOL: Address = "0x6Ae43d3271ff6888e7Fc43Fd7321a503ff738951";
const SWAP_ROUTER_02: Address = "0x3bFA4769FB09eefC5a80d6E87c3B9C650f7Ae48E";
const USDC: Address = "0x94a9D9AC8a22534E3FaCa9F4e7F2E2cf85d5E4C8"; // 6 decimals
const WETH: Address = "0xC558DBdd856501FCd9aaF1E62eae57A9F0629a3c"; // 18 decimals

/** The un-squatted, correctly-priced Uniswap V3 fee tier for this pair on Sepolia — see
 * seedPool.ts's header for the on-chain evidence the usual 3000 tier is unusable here. */
const FEE_TIER = 10000;

const OCUSDC_NAME = "Occulta USDC";
const OCUSDC_SYMBOL = "ocUSDC";
const OCUSDC_CONTRACT_URI = "https://occulta.example/ocusdc.json"; // same convention as the unit tests

const VAULT_NAME = "Occulta Vault USDC";
const VAULT_SYMBOL = "ovUSDC";
const VAULT_CONTRACT_URI = "https://occulta.example/ovault.json";
const VAULT_SALT = keccak256(toHex("occulta-deploy-vault-v1"));

const AGENT_NAME = "Occulta Demo Agent";
const AGENT_MANDATE =
  "Confidential USDC/WETH allocation across Aave V3 supply and Uniswap V3 swaps on Sepolia — single-operator demo runtime.";
/** Policy slot convention per {IStrategyRegistry-registerAgent}: targetWeightBps,
 * rebalanceTriggerBps, maxLeverageBps, riskCapBps — same demo values the unit-test suite uses
 * (StrategyRegistry.test.ts). This is a public demo policy, not real strategist alpha, so the
 * same values are used on every network; nothing in this script ever decrypts them. */
const POLICY_VALUES = [6000n, 500n, 20000n, 3000n] as const;

/** Bounds how long this script will wait on the live Nox gateway before giving up — see the
 * fork-vs-live note above. Applies per gateway call (client creation, and each of the 4
 * `encryptInput`s). */
const GATEWAY_TIMEOUT_MS = 20_000;

const withTimeout = <T>(p: Promise<T>, ms: number, label: string): Promise<T> =>
  Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)),
  ]);

function assertWiring(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`POST-WIRING ASSERTION FAILED: ${message}`);
  }
}

/** Pulls the deployed vault address out of a `createVault` receipt by reading `topics[1]` (the
 * indexed `vault` param) directly, rather than full-ABI-decoding the event — same approach
 * test/unit/OccultaVaultFactory.test.ts uses, and for the same reason: `VaultCreated` has five
 * params and no `salt`, so decoding against the wrong shape would silently misread the address. */
function vaultAddressFromReceipt(
  receipt: { logs: readonly { address: string; topics: readonly `0x${string}`[] }[] },
  factoryAddress: string,
): Address {
  const log = receipt.logs.find(
    (l) => l.address.toLowerCase() === factoryAddress.toLowerCase() && l.topics.length === 4,
  );
  if (!log) throw new Error("VaultCreated log not found in createVault receipt");
  return getAddress(`0x${log.topics[1]!.slice(-40)}`);
}

async function main() {
  const connection = await network.create();
  const { viem, networkName } = connection;
  const [deployer] = await viem.getWalletClients();
  const publicClient = await viem.getPublicClient();
  const chainId = await publicClient.getChainId();

  const isLiveSepolia = networkName === "sepolia";

  console.log(`== Occulta deploy ==`);
  console.log(`network:  ${networkName} (chainId ${chainId})`);
  console.log(`deployer: ${deployer.account.address}`);
  console.log(
    `ETH balance: ${formatEther(await publicClient.getBalance({ address: deployer.account.address }))} ETH`,
  );

  const AGENT_RUNTIME: Address = deployer.account.address;
  console.log(`AGENT_RUNTIME (demo, single-operator): ${AGENT_RUNTIME}`);

  // Running gas total across every transaction this script sends (deployments and writes) —
  // printed at the end as a live-cost estimate, and independent of the pool-seeding gas
  // scripts/seedPool.ts logs on its own (folded back in at the end, from its own tx receipts).
  let gasUnits = 0n;
  let gasCostWei = 0n;
  const txHashes: Record<string, Hash> = {};

  /** Waits for `hash`, aborts loudly on revert, and folds its cost into the running gas total. */
  async function trackReceipt(label: string, hash: Hash) {
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") {
      throw new Error(`${label} reverted (tx ${hash})`);
    }
    gasUnits += receipt.gasUsed;
    gasCostWei += receipt.gasUsed * receipt.effectiveGasPrice;
    txHashes[label] = hash;
    console.log(`  ${label}: tx ${hash}, gasUsed ${receipt.gasUsed}`);
    return receipt;
  }

  /**
   * Confirms a `viem.sendDeploymentTransaction` result, tracks its gas, and returns the fully
   * typed contract plus the exact nonce its deployment transaction used (needed for the
   * NetSettler address prediction below). Generic over the contract type so callers keep full
   * `.read`/`.write` type inference from the `sendDeploymentTransaction("ContractName", args)`
   * call site — this helper never touches (or erases) that type itself.
   */
  async function trackDeployment<C extends { address: Address }>(
    deployment: Promise<{ contract: C; deploymentTransaction: { hash: Hash; nonce: number | bigint } }>,
    label: string,
  ): Promise<{ contract: C; nonce: number }> {
    const { contract, deploymentTransaction } = await deployment;
    await trackReceipt(label, deploymentTransaction.hash);
    console.log(`  ${label} deployed at ${contract.address}`);
    return { contract, nonce: Number(deploymentTransaction.nonce) };
  }

  // ===========================================================================================
  // 1. StrategyRegistry
  // ===========================================================================================
  console.log(`\n[1] StrategyRegistry`);
  const { contract: registry } = await trackDeployment(
    viem.sendDeploymentTransaction("StrategyRegistry"),
    "deployStrategyRegistry",
  );

  // ===========================================================================================
  // 2. registerAgent — confidential policy, best-effort on anything but live sepolia. See the
  // module header for the full reasoning.
  // ===========================================================================================
  console.log(`\n[2] registerAgent (confidential policy via the live Nox gateway)`);
  let agentId: bigint | undefined;
  let agentRegistered = false;
  try {
    const handleClient = await withTimeout(
      createViemHandleClient(deployer),
      GATEWAY_TIMEOUT_MS,
      "Nox handle client creation",
    );
    const handles: `0x${string}`[] = [];
    const proofs: `0x${string}`[] = [];
    for (let i = 0; i < POLICY_VALUES.length; i++) {
      const { handle, handleProof } = await withTimeout(
        handleClient.encryptInput(POLICY_VALUES[i]!, "uint256", registry.address),
        GATEWAY_TIMEOUT_MS,
        `policy slot ${i} encryption`,
      );
      handles.push(handle);
      proofs.push(handleProof);
    }

    const nextAgentId = (await registry.read.agentCount()) as bigint;
    const hash = await registry.write.registerAgent(
      [AGENT_NAME, AGENT_MANDATE, AGENT_RUNTIME, handles, proofs],
      { account: deployer.account },
    );
    await trackReceipt("registerAgent", hash);

    agentId = nextAgentId;
    agentRegistered = true;
    console.log(`  agentId: ${agentId}`);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    if (isLiveSepolia) {
      throw new Error(
        `registerAgent is REQUIRED on live sepolia and it failed — aborting the deploy rather ` +
          `than leave a real deployment with no registered agent. Underlying error: ${reason}`,
      );
    }
    console.warn(
      `  [skip] registerAgent did not complete on ${networkName} (best-effort off live sepolia): ${reason}`,
    );
    console.warn(
      `  [skip] continuing without an agentId — steps 3-12 do not depend on one, except the ` +
        `registry.metaOf(agentId) wiring assertion in step 10, which is skipped below.`,
    );
  }

  // ===========================================================================================
  // 3. OccultaUSDC
  // ===========================================================================================
  console.log(`\n[3] OccultaUSDC`);
  const { contract: occultaUSDC } = await trackDeployment(
    viem.sendDeploymentTransaction("OccultaUSDC", [USDC, OCUSDC_NAME, OCUSDC_SYMBOL, OCUSDC_CONTRACT_URI]),
    "deployOccultaUSDC",
  );

  // ===========================================================================================
  // 4. OccultaVaultFactory + createVault
  // ===========================================================================================
  console.log(`\n[4] OccultaVaultFactory + createVault`);
  const { contract: vaultFactory } = await trackDeployment(
    viem.sendDeploymentTransaction("OccultaVaultFactory"),
    "deployOccultaVaultFactory",
  );

  const createVaultArgs = [
    occultaUSDC.address,
    VAULT_NAME,
    VAULT_SYMBOL,
    VAULT_CONTRACT_URI,
    AGENT_RUNTIME,
    VAULT_SALT,
  ] as const;
  const createVaultHash = await vaultFactory.write.createVault(createVaultArgs, { account: deployer.account });
  const createVaultReceipt = await trackReceipt("createVault", createVaultHash);
  const vaultAddress = vaultAddressFromReceipt(createVaultReceipt, vaultFactory.address);
  const vault = await viem.getContractAt("OccultaVault", vaultAddress);
  console.log(`  vault deployed at ${vaultAddress}`);

  assertWiring(
    getAddress((await vault.read.owner()) as string) === getAddress(AGENT_RUNTIME),
    `vault.owner() must equal AGENT_RUNTIME immediately after createVault`,
  );

  // ===========================================================================================
  // 5. AaveAdapter + UniswapAdapter (temp owner = deployer)
  // ===========================================================================================
  console.log(`\n[5] AaveAdapter + UniswapAdapter (temp owner = deployer)`);
  const { contract: aaveAdapter } = await trackDeployment(
    viem.sendDeploymentTransaction("AaveAdapter", [AAVE_POOL, deployer.account.address]),
    "deployAaveAdapter",
  );
  const { contract: uniswapAdapter } = await trackDeployment(
    viem.sendDeploymentTransaction("UniswapAdapter", [SWAP_ROUTER_02, deployer.account.address]),
    "deployUniswapAdapter",
  );

  // ===========================================================================================
  // 6. Pre-compute NetSettler's deployment address from this deployer's CURRENT nonce: the next
  // transaction (step 7) consumes `nonce`, the one right after that (step 8, NetSettler itself)
  // consumes `nonce + 1` — provided nothing else from this deployer is sent in between, which
  // this script guarantees by sending exactly those two transactions back to back.
  // ===========================================================================================
  console.log(`\n[6] pre-computing NetSettler's deployment address`);
  const nonceBeforeExecutor = await publicClient.getTransactionCount({ address: deployer.account.address });
  const predictedNetSettler = getContractAddress({
    from: deployer.account.address,
    nonce: BigInt(nonceBeforeExecutor) + 1n,
  });
  console.log(`  deployer nonce before OccultaExecutor: ${nonceBeforeExecutor}`);
  console.log(`  predicted NetSettler address: ${predictedNetSettler}`);

  // ===========================================================================================
  // 7. OccultaExecutor, constructed against the PREDICTED NetSettler address.
  // ===========================================================================================
  console.log(`\n[7] OccultaExecutor`);
  const { contract: executor, nonce: executorNonce } = await trackDeployment(
    viem.sendDeploymentTransaction("OccultaExecutor", [
      aaveAdapter.address,
      uniswapAdapter.address,
      USDC,
      WETH,
      FEE_TIER,
      predictedNetSettler,
      deployer.account.address,
    ]),
    "deployOccultaExecutor",
  );
  assertWiring(
    executorNonce === nonceBeforeExecutor,
    `OccultaExecutor's actual deployment nonce (${executorNonce}) must equal the nonce read just ` +
      `before it (${nonceBeforeExecutor}) — otherwise another transaction slipped in and the ` +
      `NetSettler prediction below is no longer valid`,
  );

  // ===========================================================================================
  // 8. NetSettler — deployed immediately after OccultaExecutor, at the predicted address.
  // ===========================================================================================
  console.log(`\n[8] NetSettler`);
  const { contract: netSettler, nonce: netSettlerNonce } = await trackDeployment(
    viem.sendDeploymentTransaction("NetSettler", [registry.address, executor.address]),
    "deployNetSettler",
  );
  assertWiring(
    getAddress(netSettler.address) === getAddress(predictedNetSettler),
    `NetSettler deployed at ${netSettler.address} but the predicted address (from OccultaExecutor's ` +
      `nonce + 1) was ${predictedNetSettler} — the circular-immutable wiring is BROKEN. Aborting.`,
  );
  assertWiring(
    netSettlerNonce === nonceBeforeExecutor + 1,
    `NetSettler's actual deployment nonce (${netSettlerNonce}) must equal executor's nonce + 1 ` +
      `(${nonceBeforeExecutor + 1})`,
  );

  // ===========================================================================================
  // 9. Transfer both adapters' ownership to the executor — the only account able to drive them
  // from this point on.
  // ===========================================================================================
  console.log(`\n[9] transferOwnership(executor) on both adapters`);
  const transferAaveHash = await aaveAdapter.write.transferOwnership([executor.address], {
    account: deployer.account,
  });
  await trackReceipt("transferOwnershipAaveAdapter", transferAaveHash);
  const transferUniswapHash = await uniswapAdapter.write.transferOwnership([executor.address], {
    account: deployer.account,
  });
  await trackReceipt("transferOwnershipUniswapAdapter", transferUniswapHash);

  // ===========================================================================================
  // 10. Post-wiring assertions — abort loudly if ANY fails. Nothing past this point should ever
  // run against a deployment whose wiring is not exactly what the audit specified.
  // ===========================================================================================
  console.log(`\n[10] post-wiring assertions`);

  assertWiring(
    getAddress((await executor.read.settler()) as string) === getAddress(netSettler.address),
    `executor.settler() must equal the deployed NetSettler address`,
  );
  assertWiring(
    getAddress((await netSettler.read.executor()) as string) === getAddress(executor.address),
    `netSettler.executor() must equal the deployed OccultaExecutor address`,
  );
  assertWiring(
    getAddress((await aaveAdapter.read.owner()) as string) === getAddress(executor.address),
    `aaveAdapter.owner() must equal the executor after transferOwnership`,
  );
  assertWiring(
    getAddress((await uniswapAdapter.read.owner()) as string) === getAddress(executor.address),
    `uniswapAdapter.owner() must equal the executor after transferOwnership`,
  );
  assertWiring(
    getAddress((await vault.read.owner()) as string) === getAddress(AGENT_RUNTIME),
    `vault.owner() must still equal AGENT_RUNTIME`,
  );

  if (agentId !== undefined) {
    const meta = (await registry.read.metaOf([agentId])) as {
      strategist: string;
      runtime: string;
      name: string;
      mandate: string;
      active: boolean;
    };
    assertWiring(
      getAddress(meta.runtime) === getAddress(AGENT_RUNTIME),
      `registry.metaOf(agentId).runtime must equal AGENT_RUNTIME`,
    );
    assertWiring(meta.active === true, `registry.metaOf(agentId).active must be true`);
    console.log(`  registry.metaOf(${agentId}): runtime OK, active OK`);
  } else {
    console.log(`  [skip] registry.metaOf(agentId) assertion — no agentId was registered this run`);
  }

  assertWiring(
    getAddress((await executor.read.usdc()) as string) === getAddress(USDC),
    `executor.usdc() must equal the live Aave-USDC address`,
  );
  assertWiring(
    getAddress((await executor.read.weth()) as string) === getAddress(WETH),
    `executor.weth() must equal the live Aave-WETH address`,
  );
  assertWiring(
    Number(await executor.read.fee()) === FEE_TIER,
    `executor.fee() must equal the ${FEE_TIER} fee tier`,
  );

  console.log(`  all post-wiring assertions PASSED`);

  // ===========================================================================================
  // 11. Seed the Uniswap pool — reusing scripts/seedPool.ts's seedPool() against THIS SAME
  // connection (critical on a fork: a second, independent network.create() would fork live
  // Sepolia state again into an unrelated in-memory chain the contracts deployed above would
  // never see). writeArtifactFile: false — this script writes its own, more comprehensive
  // artifact in step 12.
  // ===========================================================================================
  console.log(`\n[11] seeding the Aave-USDC/Aave-WETH Uniswap pool`);
  const seedResult: SeedPoolResult = await seedPool(connection, { writeArtifactFile: false });

  let poolSeedGasUnits = 0n;
  let poolSeedGasCostWei = 0n;
  for (const [label, hash] of Object.entries(seedResult.txHashes)) {
    const receipt = await publicClient.getTransactionReceipt({ hash });
    poolSeedGasUnits += receipt.gasUsed;
    poolSeedGasCostWei += receipt.gasUsed * receipt.effectiveGasPrice;
    txHashes[`seedPool.${label}`] = hash;
  }
  gasUnits += poolSeedGasUnits;
  gasCostWei += poolSeedGasCostWei;

  assertWiring(seedResult.poolAddress !== undefined, `pool seeding must return a pool address`);
  console.log(`  pool address: ${seedResult.poolAddress}`);
  console.log(
    `  demo-swap price impact: USDC->WETH ${Number(seedResult.demoSwapImpact.usdcToWethImpactBps) / 100}%, ` +
      `WETH->USDC ${Number(seedResult.demoSwapImpact.wethToUsdcImpactBps) / 100}% (QuoterV2 sanity check passed)`,
  );

  // ===========================================================================================
  // 12. Write the comprehensive, non-secret deployment artifact.
  // ===========================================================================================
  console.log(`\n[12] writing deployment artifact`);

  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const outDir = path.join(scriptDir, "..", "deployments");
  await mkdir(outDir, { recursive: true });
  const outFile = path.join(outDir, `${networkName}.json`);

  const artifact = {
    chainId,
    network: networkName,
    deployedAt: new Date().toISOString(),
    deployer: deployer.account.address,
    agentRuntime: AGENT_RUNTIME,
    agent: {
      registered: agentRegistered,
      agentId: agentId !== undefined ? agentId.toString() : null,
      name: agentRegistered ? AGENT_NAME : null,
      mandate: agentRegistered ? AGENT_MANDATE : null,
      note: agentRegistered
        ? "registered via the live Nox gateway; policy slots are sealed and were never decrypted by this script"
        : `skipped on ${networkName} — best-effort off live sepolia (see script header); no agentId exists this run`,
    },
    addresses: {
      strategyRegistry: registry.address,
      occultaUSDC: occultaUSDC.address,
      occultaVaultFactory: vaultFactory.address,
      occultaVault: vaultAddress,
      aaveAdapter: aaveAdapter.address,
      uniswapAdapter: uniswapAdapter.address,
      occultaExecutor: executor.address,
      netSettler: netSettler.address,
      aavePool: AAVE_POOL,
      swapRouter02: SWAP_ROUTER_02,
      usdc: USDC,
      weth: WETH,
    },
    pool: {
      address: seedResult.poolAddress,
      fee: FEE_TIER,
      createdThisRun: seedResult.createdThisRun,
      quotes: {
        oneWethInUsdc: seedResult.quotes.wethToUsdc.toString(),
        oneThousandUsdcInWeth: seedResult.quotes.usdcToWeth.toString(),
      },
      demoSwapPriceImpactBps: {
        usdcToWeth: seedResult.demoSwapImpact.usdcToWethImpactBps.toString(),
        wethToUsdc: seedResult.demoSwapImpact.wethToUsdcImpactBps.toString(),
      },
    },
    wiring: {
      executorSettlerEqualsNetSettler: true,
      netSettlerExecutorEqualsExecutor: true,
      aaveAdapterOwnerEqualsExecutor: true,
      uniswapAdapterOwnerEqualsExecutor: true,
      vaultOwnerEqualsAgentRuntime: true,
      registryMetaAssertionChecked: agentId !== undefined,
      executorAssetsMatchLiveAave: true,
    },
    gas: {
      totalGasUnits: gasUnits.toString(),
      totalGasCostWei: gasCostWei.toString(),
      totalGasCostEth: formatEther(gasCostWei),
      poolSeedGasUnits: poolSeedGasUnits.toString(),
      poolSeedGasCostEth: formatEther(poolSeedGasCostWei),
    },
    txHashes,
  };

  await writeFile(outFile, JSON.stringify(artifact, null, 2) + "\n", "utf8");
  console.log(`  wrote deployment artifact: ${outFile}`);

  // ===========================================================================================
  // Summary
  // ===========================================================================================
  console.log(`\n== deploy complete ==`);
  console.log(`strategyRegistry:    ${registry.address}`);
  console.log(`agentId:             ${agentId !== undefined ? agentId : "(none — skipped, see above)"}`);
  console.log(`occultaUSDC:         ${occultaUSDC.address}`);
  console.log(`occultaVaultFactory: ${vaultFactory.address}`);
  console.log(`occultaVault:        ${vaultAddress}`);
  console.log(`aaveAdapter:         ${aaveAdapter.address}`);
  console.log(`uniswapAdapter:      ${uniswapAdapter.address}`);
  console.log(`occultaExecutor:     ${executor.address}`);
  console.log(`netSettler:          ${netSettler.address}`);
  console.log(`uniswapPool:         ${seedResult.poolAddress}`);
  console.log(`total gas used:      ${gasUnits} units (${formatEther(gasCostWei)} ETH at this run's gas prices)`);
  if (!isLiveSepolia) {
    console.log(
      `\nThis was a FORK run (${networkName}). It skipped nothing in steps 1, 3-12 — every ` +
        `deployment, wiring transfer, and post-wiring assertion above ran for real against the ` +
        `forked, genuine Aave V3 / Uniswap V3 state.${
          agentRegistered
            ? " Step 2 (registerAgent) also completed for real, via the live Nox gateway."
            : " Step 2 (registerAgent) did not complete this run — see the [skip] lines above."
        } What a live run adds: the live Nox gateway will actually be able to RESOLVE (index and ` +
        `later decrypt) the handles it creates, since it watches real Sepolia — a fork's ` +
        `transactions are invisible to that indexer regardless of whether registerAgent itself ` +
        `succeeded.`,
    );
  }
}

main().catch((err) => {
  console.error("\ndeploy.ts failed:");
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
