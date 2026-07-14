import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { network } from "hardhat";
import { formatEther, formatUnits, parseAbi, parseEther, zeroAddress, type Address, type Hash } from "viem";

/**
 * Task 9 — production seeding script for Occulta's own Aave-USDC/Aave-WETH Uniswap V3 pool on
 * ETH Sepolia.
 *
 * Why this pool exists at all: there is no deeply-liquid Uniswap pool on Sepolia whose BOTH
 * tokens are Aave-supported — the deep pools pair a different USDC and the canonical WETH9,
 * neither of which Aave accepts here. Task 7's AaveAdapter and Task 8's UniswapAdapter are
 * deliberately meant to compose over the SAME assets, so this script creates and seeds a real
 * Aave-USDC/Aave-WETH pool itself via the real NonfungiblePositionManager — genuine Uniswap V3
 * code, genuine tokens, genuine self-provisioned liquidity that cannot be pulled out from under
 * the demo. This is the productionised form of what test/integration/Uniswap.fork.test.ts already
 * does inline; the token/fee/tick constants and the sqrtPriceX96 derivation below are reused
 * verbatim from that test.
 *
 * Fee tier: 10000 (1%), NOT the usual 3000. A direct on-chain query of the real
 * UniswapV3Factory.getPool(USDC, WETH, fee) on live Sepolia found the 3000-fee pool for this
 * exact pair already carries real liquidity at a wildly wrong price (~800x off) — someone else's
 * live instance of the very decimals mixup this script is careful to avoid. The 10000-fee tier
 * for this pair returned the zero address (genuinely un-created) and
 * factory.feeAmountTickSpacing(10000) == 200, confirming it is an enabled, clean tier.
 *
 * Safe to re-run: this script checks on-chain state before writing anything (createPool/mint) and
 * exits without spending gas if a correctly-priced pool already exists — see step 2 below.
 *
 * Usage:
 *   pnpm seed:fork     -> hardhat run scripts/seedPool.ts --network sepoliaFork (EDR fork, verification)
 *   pnpm seed:sepolia  -> hardhat run scripts/seedPool.ts --network sepolia     (live)
 */

/** Verified live Uniswap V3 addresses on ETH Sepolia (chainId 11155111). */
const SWAP_ROUTER_02: Address = "0x3bFA4769FB09eefC5a80d6E87c3B9C650f7Ae48E";
const QUOTER_V2: Address = "0xEd1f6473345F45b75F8179591dd5bA1888cf2FB3";
const FACTORY: Address = "0x0227628f3F023bb0B980b67D528571c95c6DaC1c";
const POSITION_MANAGER: Address = "0x1238536071E1c677A632429e3655c799b22cDA52";

/** Same Aave-supported assets Task 7's AaveAdapter and Task 8's UniswapAdapter use — deliberate
 * coherence between the lending leg and the swap leg of the demo. */
const FAUCET: Address = "0xC959483DBa39aa9E78757139af0e9a2EDEb3f42D";
const USDC: Address = "0x94a9D9AC8a22534E3FaCa9F4e7F2E2cf85d5E4C8"; // 6 decimals
const WETH: Address = "0xC558DBdd856501FCd9aaF1E62eae57A9F0629a3c"; // 18 decimals, payable deposit()
const USDC_DECIMALS = 6;
const WETH_DECIMALS = 18;

const FEE_TIER = 10000; // 1% — see the fee-tier note above.

/** Faucet is capped at 10,000 units/call (scaled by decimals); this script loops to reach the
 * target instead of assuming a single call suffices. */
const FAUCET_MINT_CAP = 10_000n * 10n ** BigInt(USDC_DECIMALS); // 10,000 USDC per call

/** Target liquidity offered to the position. Chosen to match the fork test this script
 * productionises, giving the pool enough depth that a demo-sized swap has modest price impact. */
const USDC_SEED_TARGET = 20_000n * 10n ** BigInt(USDC_DECIMALS); // 20,000 USDC
const WETH_SEED_TARGET = 10n * 10n ** BigInt(WETH_DECIMALS); // 10 WETH

/**
 * `sqrtPriceX96` derivation for token0 = Aave-USDC (6 decimals), token1 = Aave-WETH (18
 * decimals), targeting a real-world price of 1 WETH = 3,000 USDC. Reused verbatim from
 * test/integration/Uniswap.fork.test.ts (Task 8) — this is the exact derivation Task 9's brief
 * calls out as the classic trap that has already claimed one live pool on this testnet.
 *
 * Uniswap V3 tracks `price = token1_raw / token0_raw` — how many raw token1 units one raw
 * token0 unit is worth — NOT the human "USD per WETH" figure directly; the two only coincide
 * when both tokens share the same decimals count, which USDC (6) and WETH (18) do not.
 * Converting the human price into that raw ratio:
 *
 *   humanPrice(token0 in token1) = (token1_raw / token0_raw) * 10^(decimals0 - decimals1)
 *   => priceRaw = humanPrice(token0 in token1) * 10^(decimals1 - decimals0)
 *
 * Here humanPrice(1 USDC in WETH) = 1 / 3000 (one USDC is worth 1/3000 WETH), and
 * decimals1 - decimals0 = 18 - 6 = 12, so:
 *
 *   priceRaw = (1 / 3000) * 10^12 = 10^18 / (3000 * 10^6)
 *
 * — exactly "1 WETH's raw amount over 3,000 USDC's raw amount," i.e. `priceNumerator /
 * priceDenominator` below: two amounts of equal real-world value, expressed in raw units.
 *
 * `sqrtPriceX96 = floor(sqrt(priceRaw) * 2^96) = floor(sqrt(priceRaw * 2^192))`, computed
 * entirely in integer arithmetic via Newton's method (`isqrt`) so no floating-point error enters
 * the derivation at any step.
 */
function isqrt(value: bigint): bigint {
  if (value < 0n) throw new Error("isqrt of a negative number");
  if (value < 2n) return value;
  let x0 = value;
  let x1 = (x0 + 1n) / 2n;
  while (x1 < x0) {
    x0 = x1;
    x1 = (x0 + value / x0) / 2n;
  }
  return x0;
}

const Q192 = 2n ** 192n;
const TARGET_USDC_PER_WETH = 3000n;
const priceNumerator = 10n ** BigInt(WETH_DECIMALS); // 1 WETH, raw
const priceDenominator = TARGET_USDC_PER_WETH * 10n ** BigInt(USDC_DECIMALS); // 3,000 USDC, raw
const SQRT_PRICE_X96_USDC_WETH = isqrt((priceNumerator * Q192) / priceDenominator);

/** Wide, effectively full-range position for the 1% tier's tick spacing (200): the nearest
 * usable ticks to Uniswap's global MIN_TICK/MAX_TICK (-887272 / 887272) that are multiples of
 * 200 without exceeding that range (-887272 / 200 = -4436.36, so -4436 * 200 = -887200; mirrored
 * for the upper bound). Reused verbatim from the Task 8 fork test. */
const TICK_LOWER = -887200;
const TICK_UPPER = 887200;

/** Sane band for the post-seed / idempotency-check quote, centered on the 3,000 USDC/WETH target
 * price and wide enough to absorb this pool's own price impact and any real trading that has
 * happened against it since — while still catching a wrong-order-of-magnitude sqrtPriceX96 (the
 * live 3000-fee pool for this pair is mispriced by ~800x, so even a generous band like this one
 * catches that class of failure easily). */
const MIN_USDC_PER_ONE_WETH = 2_000n * 10n ** BigInt(USDC_DECIMALS);
const MAX_USDC_PER_ONE_WETH = 4_000n * 10n ** BigInt(USDC_DECIMALS);
const MIN_WETH_PER_1000_USDC = (250n * 10n ** BigInt(WETH_DECIMALS)) / 1000n; // 0.25 WETH
const MAX_WETH_PER_1000_USDC = (500n * 10n ** BigInt(WETH_DECIMALS)) / 1000n; // 0.50 WETH

const GAS_BUFFER = parseEther("0.05");

const erc20Abi = parseAbi([
  "function balanceOf(address account) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
]);

const faucetAbi = parseAbi([
  "function mint(address token, address to, uint256 amount) returns (uint256)",
]);

const wethAbi = parseAbi(["function deposit() payable"]);

const factoryAbi = parseAbi([
  "function getPool(address tokenA, address tokenB, uint24 fee) view returns (address pool)",
]);

const positionManagerAbi = parseAbi([
  "function createAndInitializePoolIfNecessary(address token0, address token1, uint24 fee, uint160 sqrtPriceX96) payable returns (address pool)",
  "function mint((address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint256 amount0Desired, uint256 amount1Desired, uint256 amount0Min, uint256 amount1Min, address recipient, uint256 deadline) params) payable returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)",
]);

const quoterAbi = parseAbi([
  "function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96) params) returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)",
]);

interface Quotes {
  wethToUsdc: bigint;
  usdcToWeth: bigint;
}

async function main() {
  // token0/token1 sort sanity: the whole sqrtPriceX96 derivation above assumes USDC < WETH by
  // address. If this ever stopped holding (it can't, both are fixed constants, but the check is
  // free and matches the fork test's own defensive assertion) the derived price would silently
  // be for the wrong pair orientation.
  if (!(BigInt(USDC) < BigInt(WETH))) {
    throw new Error("expected USDC to sort as token0 — sqrtPriceX96 derivation assumes this order");
  }

  const connection = await network.create();
  const { viem, networkName } = connection;
  const [deployer] = await viem.getWalletClients();
  const publicClient = await viem.getPublicClient();
  const chainId = await publicClient.getChainId();

  console.log(`== Occulta pool seeder ==`);
  console.log(`network:   ${networkName} (chainId ${chainId})`);
  console.log(`deployer:  ${deployer.account.address}`);

  const ethBalance = await publicClient.getBalance({ address: deployer.account.address });
  console.log(`ETH balance: ${formatEther(ethBalance)} ETH`);

  const readBalance = (token: Address, owner: Address) =>
    publicClient.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [owner] });

  const writeAndWait = async (label: string, send: () => Promise<Hash>): Promise<Hash> => {
    const hash = await send();
    console.log(`  ${label}: tx ${hash} submitted, waiting for confirmation...`);
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") {
      throw new Error(`${label} reverted (tx ${hash})`);
    }
    console.log(`  ${label}: confirmed in block ${receipt.blockNumber}`);
    return hash;
  };

  const checkQuotesSane = async (context: string): Promise<Quotes> => {
    let wethToUsdc: bigint;
    let usdcToWeth: bigint;
    const oneWeth = 10n ** BigInt(WETH_DECIMALS);
    const oneThousandUsdc = 1_000n * 10n ** BigInt(USDC_DECIMALS);

    try {
      const quote = await publicClient.simulateContract({
        address: QUOTER_V2,
        abi: quoterAbi,
        functionName: "quoteExactInputSingle",
        args: [{ tokenIn: WETH, tokenOut: USDC, amountIn: oneWeth, fee: FEE_TIER, sqrtPriceLimitX96: 0n }],
        account: deployer.account,
      });
      [wethToUsdc] = quote.result;
    } catch (err) {
      throw new Error(
        `${context}: QuoterV2 WETH->USDC quote failed — the pool may have no liquidity or be otherwise ` +
          `unusable. Aborting; not attempting to fix a broken pool. Underlying error: ${String(err)}`,
      );
    }
    if (!(wethToUsdc > MIN_USDC_PER_ONE_WETH && wethToUsdc < MAX_USDC_PER_ONE_WETH)) {
      throw new Error(
        `${context}: pool is MISPRICED — quoted ${formatUnits(wethToUsdc, USDC_DECIMALS)} USDC for 1 WETH, ` +
          `expected between ${formatUnits(MIN_USDC_PER_ONE_WETH, USDC_DECIMALS)} and ` +
          `${formatUnits(MAX_USDC_PER_ONE_WETH, USDC_DECIMALS)} USDC. Aborting; NOT attempting to fix a ` +
          `mispriced live pool.`,
      );
    }

    try {
      const quote = await publicClient.simulateContract({
        address: QUOTER_V2,
        abi: quoterAbi,
        functionName: "quoteExactInputSingle",
        args: [
          { tokenIn: USDC, tokenOut: WETH, amountIn: oneThousandUsdc, fee: FEE_TIER, sqrtPriceLimitX96: 0n },
        ],
        account: deployer.account,
      });
      [usdcToWeth] = quote.result;
    } catch (err) {
      throw new Error(
        `${context}: QuoterV2 USDC->WETH quote failed — the pool may have no liquidity or be otherwise ` +
          `unusable. Aborting; not attempting to fix a broken pool. Underlying error: ${String(err)}`,
      );
    }
    if (!(usdcToWeth > MIN_WETH_PER_1000_USDC && usdcToWeth < MAX_WETH_PER_1000_USDC)) {
      throw new Error(
        `${context}: pool is MISPRICED — quoted ${formatUnits(usdcToWeth, WETH_DECIMALS)} WETH for 1,000 ` +
          `USDC, expected between ${formatUnits(MIN_WETH_PER_1000_USDC, WETH_DECIMALS)} and ` +
          `${formatUnits(MAX_WETH_PER_1000_USDC, WETH_DECIMALS)} WETH. Aborting; NOT attempting to fix a ` +
          `mispriced live pool.`,
      );
    }

    return { wethToUsdc, usdcToWeth };
  };

  const writeArtifact = async (args: {
    poolAddress: Address;
    quotes: Quotes;
    createdThisRun: boolean;
    txHashes: Record<string, Hash>;
    amountsDeposited?: { usdc: bigint; weth: bigint };
  }) => {
    const scriptDir = path.dirname(fileURLToPath(import.meta.url));
    const outDir = path.join(scriptDir, "..", "deployments");
    await mkdir(outDir, { recursive: true });
    const outFile = path.join(outDir, `${networkName}.json`);

    const artifact = {
      chainId,
      network: networkName,
      seededAt: new Date().toISOString(),
      deployer: deployer.account.address,
      addresses: {
        swapRouter02: SWAP_ROUTER_02,
        quoterV2: QUOTER_V2,
        uniswapV3Factory: FACTORY,
        nonfungiblePositionManager: POSITION_MANAGER,
        aaveFaucet: FAUCET,
        usdc: USDC,
        weth: WETH,
      },
      pool: {
        address: args.poolAddress,
        token0: USDC,
        token1: WETH,
        fee: FEE_TIER,
        tickLower: TICK_LOWER,
        tickUpper: TICK_UPPER,
        sqrtPriceX96: SQRT_PRICE_X96_USDC_WETH.toString(),
      },
      quotes: {
        oneWethInUsdc: args.quotes.wethToUsdc.toString(),
        oneThousandUsdcInWeth: args.quotes.usdcToWeth.toString(),
      },
      createdThisRun: args.createdThisRun,
      amountsDeposited: args.amountsDeposited
        ? { usdc: args.amountsDeposited.usdc.toString(), weth: args.amountsDeposited.weth.toString() }
        : undefined,
      txHashes: args.txHashes,
    };

    await writeFile(outFile, JSON.stringify(artifact, null, 2) + "\n", "utf8");
    console.log(`\nwrote deployment artifact: ${outFile}`);
  };

  // 2. Idempotency: check the real factory before touching anything else. A pool that already
  // exists at a sane price costs this run zero gas.
  const existingPool = (await publicClient.readContract({
    address: FACTORY,
    abi: factoryAbi,
    functionName: "getPool",
    args: [USDC, WETH, FEE_TIER],
  })) as Address;

  if (existingPool !== zeroAddress) {
    console.log(`\npool already exists at ${existingPool} — checking price sanity before exiting...`);
    const quotes = await checkQuotesSane(`pool at ${existingPool}`);
    console.log(
      `pool already seeded, price sane: 1 WETH ~= ${formatUnits(quotes.wethToUsdc, USDC_DECIMALS)} USDC, ` +
        `1,000 USDC ~= ${formatUnits(quotes.usdcToWeth, WETH_DECIMALS)} WETH. Exiting without spending gas.`,
    );
    await writeArtifact({ poolAddress: existingPool, quotes, createdThisRun: false, txHashes: {} });
    return;
  }

  console.log(`\nno pool yet at fee=${FEE_TIER} for this pair — seeding it now.`);

  // 1 (deferred). Only require enough ETH once we know we actually have to spend it: the
  // gas-free idempotent-exit path above must never be blocked by an underfunded wallet, since it
  // spends nothing. From here on we are committed to writing, so check now.
  const usdcBalanceBeforeMint = await readBalance(USDC, deployer.account.address);
  const wethBalanceBeforeMint = await readBalance(WETH, deployer.account.address);
  const wethShortfall =
    WETH_SEED_TARGET > wethBalanceBeforeMint ? WETH_SEED_TARGET - wethBalanceBeforeMint : 0n;
  const ethNeeded = wethShortfall + GAS_BUFFER;
  if (ethBalance < ethNeeded) {
    throw new Error(
      `deployer ETH balance too low to seed the pool: have ${formatEther(ethBalance)} ETH, need at least ` +
        `${formatEther(ethNeeded)} ETH (${formatEther(wethShortfall)} ETH to wrap into Aave-WETH via ` +
        `deposit(), plus a ${formatEther(GAS_BUFFER)} ETH gas buffer). Fund ${deployer.account.address} ` +
        `and retry.`,
    );
  }

  const txHashes: Record<string, Hash> = {};

  // 3. Faucet-mint the needed Aave-USDC (10,000-units-per-call cap; loop until the target is
  // met). Prefer wrapping ETH via Aave-WETH's own deposit() for WETH — it is direct (one call,
  // no per-call cap) versus the faucet route, which the real faucet contract rejects for WETH
  // anyway ("not mintable"; only USDC is faucet-mintable on this deployment).
  let usdcBalance = usdcBalanceBeforeMint;
  console.log(`\ndeployer USDC balance: ${formatUnits(usdcBalance, USDC_DECIMALS)}`);
  let faucetCallIndex = 0;
  while (usdcBalance < USDC_SEED_TARGET) {
    const remaining = USDC_SEED_TARGET - usdcBalance;
    const mintAmount = remaining < FAUCET_MINT_CAP ? remaining : FAUCET_MINT_CAP;
    const hash = await writeAndWait(
      `faucet mint ${formatUnits(mintAmount, USDC_DECIMALS)} USDC`,
      () =>
        deployer.writeContract({
          address: FAUCET,
          abi: faucetAbi,
          functionName: "mint",
          args: [USDC, deployer.account.address, mintAmount],
        }),
    );
    txHashes[`faucetMintUsdc${faucetCallIndex}`] = hash;
    faucetCallIndex += 1;
    usdcBalance += mintAmount;
  }
  console.log(`deployer USDC balance now: ${formatUnits(usdcBalance, USDC_DECIMALS)}`);

  // Wrap ETH into Aave-WETH for whatever shortfall remains.
  let wethBalance = wethBalanceBeforeMint;
  console.log(`deployer WETH balance: ${formatUnits(wethBalance, WETH_DECIMALS)}`);
  if (wethShortfall > 0n) {
    const hash = await writeAndWait(`wrap ${formatEther(wethShortfall)} ETH into Aave-WETH`, () =>
      deployer.writeContract({ address: WETH, abi: wethAbi, functionName: "deposit", args: [], value: wethShortfall }),
    );
    txHashes.wrapWeth = hash;
    wethBalance += wethShortfall;
  }
  console.log(`deployer WETH balance now: ${formatUnits(wethBalance, WETH_DECIMALS)}`);

  // 4/5. Approve both tokens to the position manager, then create+initialize the pool and mint a
  // wide-range position.
  txHashes.approveUsdc = await writeAndWait(`approve ${formatUnits(USDC_SEED_TARGET, USDC_DECIMALS)} USDC to position manager`, () =>
    deployer.writeContract({
      address: USDC,
      abi: erc20Abi,
      functionName: "approve",
      args: [POSITION_MANAGER, USDC_SEED_TARGET],
    }),
  );
  txHashes.approveWeth = await writeAndWait(`approve ${formatEther(WETH_SEED_TARGET)} WETH to position manager`, () =>
    deployer.writeContract({
      address: WETH,
      abi: erc20Abi,
      functionName: "approve",
      args: [POSITION_MANAGER, WETH_SEED_TARGET],
    }),
  );

  txHashes.createAndInitializePool = await writeAndWait(
    `createAndInitializePoolIfNecessary(USDC, WETH, ${FEE_TIER}, sqrtPriceX96=${SQRT_PRICE_X96_USDC_WETH})`,
    () =>
      deployer.writeContract({
        address: POSITION_MANAGER,
        abi: positionManagerAbi,
        functionName: "createAndInitializePoolIfNecessary",
        args: [USDC, WETH, FEE_TIER, SQRT_PRICE_X96_USDC_WETH],
      }),
  );

  const latestBlock = await publicClient.getBlock();
  const deadline = latestBlock.timestamp + 3600n;

  const usdcBeforeMintCall = await readBalance(USDC, deployer.account.address);
  const wethBeforeMintCall = await readBalance(WETH, deployer.account.address);

  txHashes.mintPosition = await writeAndWait(
    `mint wide-range position (ticks ${TICK_LOWER}..${TICK_UPPER})`,
    () =>
      deployer.writeContract({
        address: POSITION_MANAGER,
        abi: positionManagerAbi,
        functionName: "mint",
        args: [
          {
            token0: USDC,
            token1: WETH,
            fee: FEE_TIER,
            tickLower: TICK_LOWER,
            tickUpper: TICK_UPPER,
            amount0Desired: USDC_SEED_TARGET,
            amount1Desired: WETH_SEED_TARGET,
            amount0Min: 0n,
            amount1Min: 0n,
            recipient: deployer.account.address,
            deadline,
          },
        ],
      }),
  );

  const usdcAfterMintCall = await readBalance(USDC, deployer.account.address);
  const wethAfterMintCall = await readBalance(WETH, deployer.account.address);
  const amountsDeposited = {
    usdc: usdcBeforeMintCall - usdcAfterMintCall,
    weth: wethBeforeMintCall - wethAfterMintCall,
  };

  // 6. Verify: the pool now exists, and both quote directions land in a sane band around the
  // target price. Abort loudly (throw) rather than leave a mispriced pool behind.
  const poolAddress = (await publicClient.readContract({
    address: FACTORY,
    abi: factoryAbi,
    functionName: "getPool",
    args: [USDC, WETH, FEE_TIER],
  })) as Address;
  if (poolAddress === zeroAddress) {
    throw new Error("createAndInitializePoolIfNecessary succeeded but factory.getPool still returns the zero address");
  }

  const quotes = await checkQuotesSane(`freshly seeded pool at ${poolAddress}`);

  // 7. Summary.
  console.log(`\n== seeding complete ==`);
  console.log(`pool address:       ${poolAddress}`);
  console.log(`fee tier:           ${FEE_TIER}`);
  console.log(`tick range:         ${TICK_LOWER} .. ${TICK_UPPER}`);
  console.log(`USDC deposited:     ${formatUnits(amountsDeposited.usdc, USDC_DECIMALS)}`);
  console.log(`WETH deposited:     ${formatUnits(amountsDeposited.weth, WETH_DECIMALS)}`);
  console.log(`quote 1 WETH ->     ${formatUnits(quotes.wethToUsdc, USDC_DECIMALS)} USDC`);
  console.log(`quote 1,000 USDC -> ${formatUnits(quotes.usdcToWeth, WETH_DECIMALS)} WETH`);
  console.log(`transactions:`);
  for (const [label, hash] of Object.entries(txHashes)) {
    console.log(`  ${label}: ${hash}`);
  }

  await writeArtifact({ poolAddress, quotes, createdThisRun: true, txHashes, amountsDeposited });
}

main().catch((err) => {
  console.error("\nseedPool.ts failed:");
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
