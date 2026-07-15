import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { network } from "hardhat";
import { formatEther, formatUnits, parseAbi, zeroAddress, type Address, type Hash } from "viem";

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
 * the demo. The token/fee/tick-spacing constants and the sqrtPriceX96 derivation below are reused
 * verbatim from test/integration/Uniswap.fork.test.ts (Task 8).
 *
 * Fee tier: 10000 (1%), NOT the usual 3000. A direct on-chain query of the real
 * UniswapV3Factory.getPool(USDC, WETH, fee) on live Sepolia found the 3000-fee pool for this
 * exact pair already carries real liquidity at a wildly wrong price (~800x off) — someone else's
 * live instance of the very decimals mixup this script is careful to avoid. The 10000-fee tier
 * for this pair returned the zero address (genuinely un-created) and
 * factory.feeAmountTickSpacing(10000) == 200, confirming it is an enabled, clean tier.
 *
 * Funding the position — faucet first, real ETH only as an unavoidable fallback:
 * Both Aave-USDC and Aave-WETH are, in principle, mintable through the same real, permissionless
 * Aave testnet Faucet (0xC959483DBa39aa9E78757139af0e9a2EDEb3f42D — `mint(token, to, amount)`,
 * capped at 10,000 units/call scaled by decimals, looped below if a target ever exceeded one
 * call). The Faucet exposes its own on-chain `isMintable(token)` flag per asset, and this script
 * checks it at runtime rather than assuming: for Aave-USDC it is (and stays) true. For Aave-WETH,
 * a direct on-chain check against live Sepolia (not a guess — an actual `mint(WETH, ...)` call,
 * both simulated and sent for real on a fork of live state) currently gets
 * `Error: not mintable`; `Faucet.isMintable(WETH)` reads `false`. Reading the Faucet's verified
 * source confirms why: it keeps a `_nonMintable` allowlist per token, toggled only by the
 * Faucet's OWNER (a fixed address this project does not control) via `setMintable`, and Aave-WETH
 * is currently in that disabled set. Aave-WETH's own `WETH9Mock.mint(address,uint256)` is
 * separately `onlyOwner`-gated too, with the Faucet contract itself (not this deployer) as that
 * owner — so there is no back door through the token either. The one genuinely permissionless way
 * to obtain Aave-WETH that remains is the token's own inherited `deposit()` — real ETH, 1:1, the
 * actual WETH9 mechanism, not a mock or a workaround.
 *
 * So: this script always tries the free faucet path for BOTH tokens first (and will use it
 * automatically for Aave-WETH too the moment its owner ever flips `isMintable(WETH)` to true —
 * nothing else about this script would need to change). Until then, Aave-WETH's shortfall is
 * covered by `deposit()`, and ONLY that shortfall — this is the one part of a run that is not
 * gas-only, and every code path that touches it says so loudly (console output, the pre-flight
 * balance check, and the deployment artifact's `wethSource` field).
 *
 * Position: a CONCENTRATED range, not full-range. Full-range Uniswap V3 liquidity is extremely
 * capital-inefficient — the previous version of this script needed ~2 real WETH to seed a
 * full-range position, and real Sepolia ETH is this project's scarce resource (the deployer's
 * live balance is ~0.06 ETH). Occulta's demo only ever executes small aggregate net orders (a few
 * to ~20 USDC per epoch); the pool only has to price THOSE swaps well. Concentrating the position
 * into a tight band around the initialized price (see TICK_LOWER/TICK_UPPER below — roughly
 * -11%/+9% around 3,000 USDC/WETH, tick-spacing-aligned) gives deep effective liquidity for
 * small swaps out of a tiny fraction of the capital: ~0.03 WETH (well under 0.05 real ETH once
 * gas is added) plus its correctly-paired USDC amount (USDC is free from the faucet, so that side
 * is sized with deliberate headroom — see the paired-amount derivation below). A dedicated
 * post-seed check (`checkDemoSwapPriceImpact`) then proves this isn't just a smaller pool but a
 * genuinely USABLE one: it quotes a real $10 swap in both directions via QuoterV2 and asserts the
 * price impact — which, at fee tier 10000, is mostly the pool's own 1% swap fee plus a thin
 * slippage margin on top — stays under 2%, aborting loudly otherwise. The band is deliberately
 * narrow (near the tight end of the brief's ±10-25% guidance) precisely so that thin slippage
 * margin stays comfortably below the 2% ceiling instead of hugging it.
 *
 * Safe to re-run: this script checks on-chain state before writing anything (createPool/mint) and
 * exits without spending gas if a correctly-priced, correctly-priced-for-the-demo pool already
 * exists — see step 2 below.
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
const WETH: Address = "0xC558DBdd856501FCd9aaF1E62eae57A9F0629a3c"; // 18 decimals, WETH9Mock
const USDC_DECIMALS = 6;
const WETH_DECIMALS = 18;

const FEE_TIER = 10000; // 1% — see the fee-tier note above.
const TICK_SPACING = 200; // factory.feeAmountTickSpacing(10000) == 200, confirmed on-chain (see header).

/** Faucet is capped at 10,000 units/call (scaled by decimals); the loop below reaches the target
 * instead of assuming a single call suffices, though at this script's position size both tokens'
 * targets fit comfortably inside one call each. */
const faucetCapFor = (decimals: number): bigint => 10_000n * 10n ** BigInt(decimals);

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

/**
 * Concentrated tick range + paired deposit amounts. This is the actual fix: a tight band around
 * the initialized price instead of Uniswap's global min/max ticks.
 *
 * `price_raw(tick) = 1.0001^tick` is the same token1_raw/token0_raw ratio
 * `SQRT_PRICE_X96_USDC_WETH` is built from above, just not yet square-rooted or Q96-scaled.
 * Unlike that constant (which sets the pool's actual on-chain price and therefore MUST be exact
 * BigInt math), the helpers below use ordinary floating point: they only choose which nearby
 * tick-spacing-aligned boundary to mint into and how much of each token to offer as an off-chain
 * ESTIMATE. The on-chain `mint()` call itself performs the exact fixed-point reconciliation and
 * refunds whichever side isn't the binding constraint, so float error here (a few parts in
 * 10^15) affects neither the pool's price nor correctness — only how tightly the (deliberately
 * generous, see below) USDC estimate matches the exact requirement.
 */
const rawPriceAtTick = (tick: number): number => Math.pow(1.0001, tick);
const sqrtRawAtTick = (tick: number): number => Math.sqrt(rawPriceAtTick(tick));

/** Inverse of `rawPriceAtTick` for a human "USDC per 1 WETH" price: solves `1.0001^tick ==
 * priceRaw` for tick, where priceRaw is derived exactly the way `SQRT_PRICE_X96_USDC_WETH`'s own
 * comment derives it (`priceRaw = humanPrice(token0 in token1) * 10^(decimals1-decimals0)`). */
const tickForUsdcPerWeth = (usdcPerWeth: number): number => {
  const priceRaw = (1 / usdcPerWeth) * 10 ** (WETH_DECIMALS - USDC_DECIMALS);
  return Math.log(priceRaw) / Math.log(1.0001);
};

const alignTick = (tick: number): number => Math.round(tick / TICK_SPACING) * TICK_SPACING;

/** Band: roughly 2,700 - 3,300 USDC/WETH (-10% / +10% of the 3,000 target), tick-aligned to
 * spacing 200 — near the tight end of the brief's requested ±10-25% guidance, chosen deliberately
 * narrow so the demo-size price-impact check below has real margin under its 2% ceiling instead
 * of hugging it (a wider ±20% band was tried first and measured ~1.95% total impact on a real
 * fork run — technically passing but too close to the edge to trust; see the Task 9 report).
 * Because tick(price) is a log scale, aligning to the nearest multiple of 200 moves each bound
 * slightly: the actual minted range ends up ~2,676 - ~3,268 USDC/WETH (-10.8% / +8.9% of the
 * target).
 * TICK_LOWER corresponds to the HIGHER USDC/WETH bound (3,300 — WETH more expensive, smaller raw
 * price ratio, smaller tick) and TICK_UPPER to the LOWER bound (2,700 — WETH cheaper, larger raw
 * price ratio, larger tick) — the same inverse relationship the sqrtPriceX96 derivation above
 * notes for the pool's own price. */
const BAND_LOWER_USDC_PER_WETH = 2_700;
const BAND_UPPER_USDC_PER_WETH = 3_300;
const TICK_LOWER = alignTick(tickForUsdcPerWeth(BAND_UPPER_USDC_PER_WETH));
const TICK_UPPER = alignTick(tickForUsdcPerWeth(BAND_LOWER_USDC_PER_WETH));

/** WETH is the scarce, real-ETH-backed side, so it is fixed first: 0.03 WETH, deliberately at the
 * low end of the brief's 0.03-0.05 suggested range so that WETH + gas stays well under the 0.05
 * ETH budget even at an elevated gas price (see ESTIMATED_GAS_UNITS below). */
const WETH_SEED_TARGET = (3n * 10n ** BigInt(WETH_DECIMALS)) / 100n; // 0.03 WETH

/** USDC is derived from WETH_SEED_TARGET and the tick range above using the standard Uniswap V3
 * in-range liquidity formulas — NOT a guessed or flat-ratio number, and NOT the naive "3,000x the
 * WETH amount" full-range shortcut (which would badly overshoot here, since a concentrated
 * position needs far less of the paired side per unit of the fixed side than a full-range one
 * does):
 *
 *   amount0 = L * (1/sqrtP - 1/sqrtPb)   (token0 = USDC)
 *   amount1 = L * (sqrtP - sqrtPa)       (token1 = WETH)
 *
 * Fixing amount1 = WETH_SEED_TARGET gives L = amount1 / (sqrtP - sqrtPa), and substituting back:
 *
 *   amount0 = amount1 * (1/sqrtP - 1/sqrtPb) / (sqrtP - sqrtPa)
 *
 * A 15% buffer is then added on top of that exact match. USDC is free from the faucet, so a
 * generous offer costs nothing, and it guarantees — by construction, not by luck of rounding —
 * that WETH (the side actually backed by real ETH) is always the binding constraint at mint time;
 * any USDC above the exact match simply never leaves the deployer's balance (mint() only pulls
 * what the fixed WETH side needs and leaves the rest). A lopsided guess in the other direction
 * would do the opposite: silently make USDC the binding constraint and strand real, already-
 * wrapped WETH un-deposited.
 */
const sqrtP0Raw = Math.sqrt(Number(priceNumerator) / Number(priceDenominator));
const sqrtPaRaw = sqrtRawAtTick(TICK_LOWER);
const sqrtPbRaw = sqrtRawAtTick(TICK_UPPER);
const USDC_PER_WETH_RAW_RATIO = (1 / sqrtP0Raw - 1 / sqrtPbRaw) / (sqrtP0Raw - sqrtPaRaw);
const USDC_HEADROOM_MULTIPLIER = 1.15;
const USDC_SEED_TARGET = BigInt(Math.ceil(Number(WETH_SEED_TARGET) * USDC_PER_WETH_RAW_RATIO * USDC_HEADROOM_MULTIPLIER));

/** Sane band for the post-seed / idempotency-check quote, centered on the 3,000 USDC/WETH target
 * price and wide enough to absorb this pool's own price impact and any real trading that has
 * happened against it since — while still catching a wrong-order-of-magnitude sqrtPriceX96 (the
 * live 3000-fee pool for this pair is mispriced by ~800x, so even a generous band like this one
 * catches that class of failure easily). Expressed as "per 1 WETH" / "per 1,000 USDC" regardless
 * of how large the actual test trade below is — see checkQuotesSane for the scaling. Deliberately
 * broader than the concentrated position's own ~2,676-3,268 range: this check exists to catch
 * gross mispricing (wrong order of magnitude), not to duplicate the tighter, demo-specific price-
 * impact assertion below. */
const MIN_USDC_PER_ONE_WETH = 2_000n * 10n ** BigInt(USDC_DECIMALS);
const MAX_USDC_PER_ONE_WETH = 4_000n * 10n ** BigInt(USDC_DECIMALS);
const MIN_WETH_PER_1000_USDC = (250n * 10n ** BigInt(WETH_DECIMALS)) / 1000n; // 0.25 WETH
const MAX_WETH_PER_1000_USDC = (500n * 10n ** BigInt(WETH_DECIMALS)) / 1000n; // 0.50 WETH

/** Demo-representative swap size: Occulta's aggregate net orders run a few to ~20 USDC per epoch
 * — this checks the pool actually prices a realistic ~$10 swap well, not just that it exists.
 * DEMO_SWAP_WETH is the same ~$10 expressed in WETH at the target price, computed from the exact
 * priceNumerator/priceDenominator ratio above (not a separate guess) so both directions test the
 * same dollar amount. MAX_PRICE_IMPACT_BPS is the brief's ~2% execution-quality target. */
const DEMO_SWAP_USDC = 10n * 10n ** BigInt(USDC_DECIMALS); // 10 USDC
const DEMO_SWAP_WETH = (DEMO_SWAP_USDC * priceNumerator) / priceDenominator; // ~10 USDC of WETH
const MAX_PRICE_IMPACT_BPS = 200n; // 2%

/** Gas budget for a full seeding run: faucet mint(s) and/or a deposit() fallback for WETH, one
 * faucet mint for USDC, two approvals, createAndInitializePoolIfNecessary (deploys a full pool
 * contract — by far the largest single cost here), and the position mint. Unchanged from the
 * previous (full-range) version of this script: the transaction shape is identical, only the
 * amounts differ, and gas cost is not amount-sensitive. See the Task 9 report for the underlying
 * fork receipts this budget is calibrated against.
 */
const ESTIMATED_GAS_UNITS = 2_500_000n;

const erc20Abi = parseAbi([
  "function balanceOf(address account) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
]);

const faucetAbi = parseAbi([
  "function mint(address token, address to, uint256 amount) returns (uint256)",
  "function isMintable(address asset) view returns (bool)",
]);

/** Aave-WETH's own inherited WETH9 `deposit()` — the sole remaining permissionless (but NOT
 * free) path to acquire it while the Faucet has it marked non-mintable. See the file header for
 * the on-chain evidence behind that "while." */
const wethDepositAbi = parseAbi(["function deposit() payable"]);

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

interface DemoSwapImpact {
  usdcToWethOut: bigint;
  usdcToWethImpactBps: bigint;
  wethToUsdcOut: bigint;
  wethToUsdcImpactBps: bigint;
}

export interface SeedPoolResult {
  poolAddress: Address;
  quotes: Quotes;
  demoSwapImpact: DemoSwapImpact;
  createdThisRun: boolean;
  txHashes: Record<string, Hash>;
  amountsDeposited?: { usdc: bigint; weth: bigint };
  wethSource?: "faucet" | "deposit-fallback";
}

/**
 * Core seeding logic, factored out so other scripts (Task 10b's scripts/deploy.ts) can reuse it
 * against an ALREADY-CREATED network connection, rather than standing up a second, independent
 * one. This matters specifically on an EDR fork: a second `network.create()` call forks live
 * Sepolia state fresh, into its own separate in-memory chain that never sees whatever the caller
 * already deployed on its own connection — so the pool this function seeds would be invisible to
 * a caller's already-deployed adapters/executor if it created its own connection instead of
 * reusing the caller's.
 *
 * `writeArtifactFile` defaults to `true` so the standalone `pnpm seed:fork` / `pnpm seed:sepolia`
 * entrypoint below (`main`) is completely unchanged. A caller maintaining its own, richer
 * deployment artifact (Task 10b's deploy script) passes `false` and folds this function's return
 * value into its own file instead.
 */
export async function seedPool(
  connection: Awaited<ReturnType<typeof network.create>>,
  options: { writeArtifactFile?: boolean } = {},
): Promise<SeedPoolResult> {
  const writeArtifactFile = options.writeArtifactFile ?? true;

  // token0/token1 sort sanity: the whole sqrtPriceX96 derivation above assumes USDC < WETH by
  // address. If this ever stopped holding (it can't, both are fixed constants, but the check is
  // free and matches the fork test's own defensive assertion) the derived price would silently
  // be for the wrong pair orientation.
  if (!(BigInt(USDC) < BigInt(WETH))) {
    throw new Error("expected USDC to sort as token0 — sqrtPriceX96 derivation assumes this order");
  }
  // Tick-range sanity: the concentrated band must actually straddle the initialized price and
  // land on valid, spacing-aligned ticks — cheap to check, and a silent failure here would mean
  // minting a position that can never hold any liquidity at the initialized price.
  if (!(TICK_LOWER % TICK_SPACING === 0 && TICK_UPPER % TICK_SPACING === 0)) {
    throw new Error(`tick range not aligned to spacing ${TICK_SPACING}: [${TICK_LOWER}, ${TICK_UPPER}]`);
  }
  if (!(TICK_LOWER < TICK_UPPER)) {
    throw new Error(`invalid tick range: TICK_LOWER (${TICK_LOWER}) must be below TICK_UPPER (${TICK_UPPER})`);
  }

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

  let gasSpent = 0n; // running total of real gas cost (gasUsed * effectiveGasPrice) across every
  // transaction this run actually sends — printed in the summary as the true, observed cost
  // alongside the pre-flight estimate above.

  const writeAndWait = async (label: string, send: () => Promise<Hash>): Promise<Hash> => {
    const hash = await send();
    console.log(`  ${label}: tx ${hash} submitted, waiting for confirmation...`);
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") {
      throw new Error(`${label} reverted (tx ${hash})`);
    }
    gasSpent += receipt.gasUsed * receipt.effectiveGasPrice;
    console.log(`  ${label}: confirmed in block ${receipt.blockNumber}`);
    return hash;
  };

  const checkQuotesSane = async (context: string): Promise<Quotes> => {
    const oneWeth = 10n ** BigInt(WETH_DECIMALS);
    const oneThousandUsdc = 1_000n * 10n ** BigInt(USDC_DECIMALS);
    // Keep the actual test trade small relative to this script's own (deliberately modest)
    // seeded depth — 10% of each side's target — so the check's OWN price impact can never itself
    // approach the sane-band edges below; the raw quote is then scaled back up to a "per whole
    // token" implied price before comparing against the band, so the band keeps meaning exactly
    // what it always did (USDC per 1 WETH / WETH per 1,000 USDC) regardless of how large the
    // underlying pool actually is.
    const testWethIn = WETH_SEED_TARGET / 10n;
    const testUsdcIn = USDC_SEED_TARGET / 10n;

    let wethToUsdcRaw: bigint;
    let usdcToWethRaw: bigint;

    try {
      const quote = await publicClient.simulateContract({
        address: QUOTER_V2,
        abi: quoterAbi,
        functionName: "quoteExactInputSingle",
        args: [{ tokenIn: WETH, tokenOut: USDC, amountIn: testWethIn, fee: FEE_TIER, sqrtPriceLimitX96: 0n }],
        account: deployer.account,
      });
      [wethToUsdcRaw] = quote.result;
    } catch (err) {
      throw new Error(
        `${context}: QuoterV2 WETH->USDC quote failed — the pool may have no liquidity or be otherwise ` +
          `unusable. Aborting; not attempting to fix a broken pool. Underlying error: ${String(err)}`,
      );
    }
    const wethToUsdc = (wethToUsdcRaw * oneWeth) / testWethIn;
    if (!(wethToUsdc > MIN_USDC_PER_ONE_WETH && wethToUsdc < MAX_USDC_PER_ONE_WETH)) {
      throw new Error(
        `${context}: pool is MISPRICED — quoted ${formatUnits(wethToUsdcRaw, USDC_DECIMALS)} USDC for ` +
          `${formatEther(testWethIn)} WETH (implied ${formatUnits(wethToUsdc, USDC_DECIMALS)} USDC per 1 WETH), ` +
          `expected the implied price between ${formatUnits(MIN_USDC_PER_ONE_WETH, USDC_DECIMALS)} and ` +
          `${formatUnits(MAX_USDC_PER_ONE_WETH, USDC_DECIMALS)} USDC. Aborting; NOT attempting to fix a ` +
          `mispriced live pool.`,
      );
    }

    try {
      const quote = await publicClient.simulateContract({
        address: QUOTER_V2,
        abi: quoterAbi,
        functionName: "quoteExactInputSingle",
        args: [{ tokenIn: USDC, tokenOut: WETH, amountIn: testUsdcIn, fee: FEE_TIER, sqrtPriceLimitX96: 0n }],
        account: deployer.account,
      });
      [usdcToWethRaw] = quote.result;
    } catch (err) {
      throw new Error(
        `${context}: QuoterV2 USDC->WETH quote failed — the pool may have no liquidity or be otherwise ` +
          `unusable. Aborting; not attempting to fix a broken pool. Underlying error: ${String(err)}`,
      );
    }
    const usdcToWeth = (usdcToWethRaw * oneThousandUsdc) / testUsdcIn;
    if (!(usdcToWeth > MIN_WETH_PER_1000_USDC && usdcToWeth < MAX_WETH_PER_1000_USDC)) {
      throw new Error(
        `${context}: pool is MISPRICED — quoted ${formatUnits(usdcToWethRaw, WETH_DECIMALS)} WETH for ` +
          `${formatUnits(testUsdcIn, USDC_DECIMALS)} USDC (implied ${formatUnits(usdcToWeth, WETH_DECIMALS)} WETH ` +
          `per 1,000 USDC), expected the implied price between ` +
          `${formatUnits(MIN_WETH_PER_1000_USDC, WETH_DECIMALS)} and ` +
          `${formatUnits(MAX_WETH_PER_1000_USDC, WETH_DECIMALS)} WETH. Aborting; NOT attempting to fix a ` +
          `mispriced live pool.`,
      );
    }

    return { wethToUsdc, usdcToWeth };
  };

  // The point of the whole exercise: prove the concentrated position is genuinely usable for the
  // demo, not just non-empty. Quotes a realistic ~$10 swap in both directions via QuoterV2's
  // staticCall (simulateContract) and asserts the price impact against the pool's INITIALIZED
  // price (not its possibly-since-moved spot price) stays under MAX_PRICE_IMPACT_BPS. Aborts
  // loudly — does not attempt to "fix" a pool that fails this.
  const checkDemoSwapPriceImpact = async (context: string): Promise<DemoSwapImpact> => {
    const expectedWethOut = (DEMO_SWAP_USDC * priceNumerator) / priceDenominator;
    const expectedUsdcOut = (DEMO_SWAP_WETH * priceDenominator) / priceNumerator;

    const quoteAndCheck = async (
      label: string,
      tokenIn: Address,
      tokenOut: Address,
      amountIn: bigint,
      amountInDecimals: number,
      expectedOut: bigint,
      outDecimals: number,
    ): Promise<{ amountOut: bigint; impactBps: bigint }> => {
      let amountOut: bigint;
      try {
        const quote = await publicClient.simulateContract({
          address: QUOTER_V2,
          abi: quoterAbi,
          functionName: "quoteExactInputSingle",
          args: [{ tokenIn, tokenOut, amountIn, fee: FEE_TIER, sqrtPriceLimitX96: 0n }],
          account: deployer.account,
        });
        [amountOut] = quote.result;
      } catch (err) {
        throw new Error(
          `${context}: demo-size ${label} quote failed — the pool cannot price a realistic demo swap at ` +
            `all. Aborting; not attempting to fix a broken pool. Underlying error: ${String(err)}`,
        );
      }
      const diff = amountOut > expectedOut ? amountOut - expectedOut : expectedOut - amountOut;
      const impactBps = (diff * 10_000n) / expectedOut;
      console.log(
        `  ${label}: ${formatUnits(amountIn, amountInDecimals)} in -> ${formatUnits(amountOut, outDecimals)} out ` +
          `(expected ${formatUnits(expectedOut, outDecimals)} at the initialized price) -> ` +
          `price impact ${Number(impactBps) / 100}%`,
      );
      if (impactBps >= MAX_PRICE_IMPACT_BPS) {
        throw new Error(
          `${context}: demo-size ${label} price impact is ${Number(impactBps) / 100}%, at/above the ` +
            `${Number(MAX_PRICE_IMPACT_BPS) / 100}% target. Aborting — this pool is not genuinely usable ` +
            `for the demo at its current concentration/size, not just non-empty.`,
        );
      }
      return { amountOut, impactBps };
    };

    console.log(`\n${context}: demo-size swap price-impact check (~$10-equivalent, both directions)`);
    const usdcToWeth = await quoteAndCheck(
      "USDC -> WETH",
      USDC,
      WETH,
      DEMO_SWAP_USDC,
      USDC_DECIMALS,
      expectedWethOut,
      WETH_DECIMALS,
    );
    const wethToUsdc = await quoteAndCheck(
      "WETH -> USDC",
      WETH,
      USDC,
      DEMO_SWAP_WETH,
      WETH_DECIMALS,
      expectedUsdcOut,
      USDC_DECIMALS,
    );

    return {
      usdcToWethOut: usdcToWeth.amountOut,
      usdcToWethImpactBps: usdcToWeth.impactBps,
      wethToUsdcOut: wethToUsdc.amountOut,
      wethToUsdcImpactBps: wethToUsdc.impactBps,
    };
  };

  const writeArtifact = async (args: SeedPoolResult) => {
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
      // Proof the concentrated position is actually usable for the demo — see
      // checkDemoSwapPriceImpact. bps values are basis points (100 = 1%).
      demoSwapPriceImpact: {
        usdcIn: DEMO_SWAP_USDC.toString(),
        usdcToWethOut: args.demoSwapImpact.usdcToWethOut.toString(),
        usdcToWethImpactBps: args.demoSwapImpact.usdcToWethImpactBps.toString(),
        wethIn: DEMO_SWAP_WETH.toString(),
        wethToUsdcOut: args.demoSwapImpact.wethToUsdcOut.toString(),
        wethToUsdcImpactBps: args.demoSwapImpact.wethToUsdcImpactBps.toString(),
      },
      createdThisRun: args.createdThisRun,
      amountsDeposited: args.amountsDeposited
        ? { usdc: args.amountsDeposited.usdc.toString(), weth: args.amountsDeposited.weth.toString() }
        : undefined,
      // "faucet" if the Aave Faucet minted the WETH leg for free; "deposit-fallback" if it had to
      // be wrapped from real ETH because Faucet.isMintable(WETH) was false at seed time — see the
      // file header. Omitted when no seeding happened this run (idempotent exit).
      wethSource: args.wethSource,
      txHashes: args.txHashes,
    };

    await writeFile(outFile, JSON.stringify(artifact, null, 2) + "\n", "utf8");
    console.log(`\nwrote deployment artifact: ${outFile}`);
  };

  // 2. Idempotency: check the real factory before touching anything else. A pool that already
  // exists at a sane, demo-usable price costs this run zero gas.
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
        `1,000 USDC ~= ${formatUnits(quotes.usdcToWeth, WETH_DECIMALS)} WETH.`,
    );
    const demoSwapImpact = await checkDemoSwapPriceImpact(`pool at ${existingPool}`);
    console.log(`demo-size price impact check passed. Exiting without spending gas.`);
    const result: SeedPoolResult = {
      poolAddress: existingPool,
      quotes,
      demoSwapImpact,
      createdThisRun: false,
      txHashes: {},
    };
    if (writeArtifactFile) await writeArtifact(result);
    return result;
  }

  console.log(`\nno pool yet at fee=${FEE_TIER} for this pair — seeding it now.`);

  // 1 (deferred). Only require enough ETH once we know we actually have to spend it: the
  // gas-free idempotent-exit path above must never be blocked by an underfunded wallet, since it
  // spends nothing. From here on we are committed to writing, so check now.
  //
  // Whether real ETH beyond gas is needed at all depends entirely on the Faucet's own current
  // isMintable(WETH) flag — a free view read, so checking it costs nothing and lets the balance
  // check below assert the true requirement instead of assuming the worst (or the best) case.
  const wethFaucetMintable = await publicClient.readContract({
    address: FAUCET,
    abi: faucetAbi,
    functionName: "isMintable",
    args: [WETH],
  });
  console.log(`\nFaucet.isMintable(WETH): ${wethFaucetMintable}`);
  if (!wethFaucetMintable) {
    console.log(
      `  the Aave Faucet currently has Aave-WETH marked non-mintable (only its owner can change ` +
        `this via setMintable — not this deployer). Falling back to WETH9Mock.deposit() for the ` +
        `WETH shortfall ONLY: real ETH, 1:1, the one part of this run that is not gas-only. If the ` +
        `Faucet owner ever enables WETH minting, this script picks the free path automatically and ` +
        `this fallback never triggers again.`,
    );
  }

  const usdcBalanceBeforeMint = await readBalance(USDC, deployer.account.address);
  const wethBalanceBeforeMint = await readBalance(WETH, deployer.account.address);
  const wethShortfall =
    WETH_SEED_TARGET > wethBalanceBeforeMint ? WETH_SEED_TARGET - wethBalanceBeforeMint : 0n;
  const wethDepositNeeded = wethFaucetMintable ? 0n : wethShortfall;

  const gasPrice = await publicClient.getGasPrice();
  const estimatedGasCost = ESTIMATED_GAS_UNITS * gasPrice;
  console.log(
    `estimated gas cost for this run: ~${formatEther(estimatedGasCost)} ETH ` +
      `(${ESTIMATED_GAS_UNITS.toLocaleString("en-US")} gas units @ ${formatUnits(gasPrice, 9)} gwei)`,
  );

  const ethNeeded = wethDepositNeeded + estimatedGasCost;
  console.log(
    `total real ETH needed for this run: ~${formatEther(ethNeeded)} ETH ` +
      `(${formatEther(wethDepositNeeded)} ETH to wrap into WETH + ~${formatEther(estimatedGasCost)} ETH gas)`,
  );
  if (ethBalance < ethNeeded) {
    throw new Error(
      wethDepositNeeded > 0n
        ? `deployer ETH balance too low to seed the pool: have ${formatEther(ethBalance)} ETH, need at ` +
          `least ${formatEther(ethNeeded)} ETH (${formatEther(wethDepositNeeded)} ETH to wrap the WETH ` +
          `shortfall via deposit() — the Faucet cannot mint WETH right now, see above — plus an ` +
          `estimated ${formatEther(estimatedGasCost)} ETH in gas). Fund ${deployer.account.address} and retry.`
        : `deployer ETH balance too low to cover this run's gas: have ${formatEther(ethBalance)} ETH, need ` +
          `at least ${formatEther(ethNeeded)} ETH, all of it gas — both tokens are faucet-minted, no ` +
          `ETH-wrapping is needed. Fund ${deployer.account.address} and retry.`,
    );
  }

  const txHashes: Record<string, Hash> = {};

  // 3. Faucet-mint whatever the Faucet will actually mint (10,000-units-per-call cap, scaled by
  // decimals; loops until the target is met — though at this script's position size, both
  // targets fit inside one call).
  const faucetMint = async (token: Address, decimals: number, target: bigint, label: string): Promise<bigint> => {
    const cap = faucetCapFor(decimals);
    let balance = await readBalance(token, deployer.account.address);
    let callIndex = 0;
    while (balance < target) {
      const remaining = target - balance;
      const amount = remaining < cap ? remaining : cap;
      const hash = await writeAndWait(`faucet mint ${formatUnits(amount, decimals)} ${label}`, () =>
        deployer.writeContract({
          address: FAUCET,
          abi: faucetAbi,
          functionName: "mint",
          args: [token, deployer.account.address, amount],
        }),
      );
      txHashes[`faucetMint${label}${callIndex}`] = hash;
      callIndex += 1;
      balance += amount;
    }
    return balance;
  };

  console.log(`\ndeployer USDC balance: ${formatUnits(usdcBalanceBeforeMint, USDC_DECIMALS)}`);
  const usdcBalance = await faucetMint(USDC, USDC_DECIMALS, USDC_SEED_TARGET, "Usdc");
  console.log(`deployer USDC balance now: ${formatUnits(usdcBalance, USDC_DECIMALS)}`);

  // WETH: free faucet path if the Faucet currently allows it, real deposit() wrap for the
  // shortfall only otherwise — see the pre-flight check above for why.
  console.log(`deployer WETH balance: ${formatUnits(wethBalanceBeforeMint, WETH_DECIMALS)}`);
  let wethBalance = wethBalanceBeforeMint;
  let wethSource: "faucet" | "deposit-fallback";
  if (wethFaucetMintable) {
    wethBalance = await faucetMint(WETH, WETH_DECIMALS, WETH_SEED_TARGET, "Weth");
    wethSource = "faucet";
  } else {
    wethSource = "deposit-fallback";
    if (wethShortfall > 0n) {
      const hash = await writeAndWait(
        `wrap ${formatEther(wethShortfall)} ETH into Aave-WETH via deposit() (faucet fallback)`,
        () =>
          deployer.writeContract({
            address: WETH,
            abi: wethDepositAbi,
            functionName: "deposit",
            args: [],
            value: wethShortfall,
          }),
      );
      txHashes.wethDepositFallback = hash;
      wethBalance += wethShortfall;
    }
  }
  console.log(`deployer WETH balance now: ${formatUnits(wethBalance, WETH_DECIMALS)} (source: ${wethSource})`);

  // 4/5. Approve both tokens to the position manager, then create+initialize the pool and mint the
  // concentrated position.
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
    `mint concentrated position (ticks ${TICK_LOWER}..${TICK_UPPER})`,
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

  // 6. Verify: the pool now exists, both quote directions land in a sane band around the target
  // price, AND a realistic demo-size swap prices well in both directions. Abort loudly (throw)
  // rather than leave a mispriced or unusable pool behind.
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
  const demoSwapImpact = await checkDemoSwapPriceImpact(`freshly seeded pool at ${poolAddress}`);

  // 7. Summary.
  console.log(`\n== seeding complete ==`);
  console.log(`pool address:       ${poolAddress}`);
  console.log(`fee tier:           ${FEE_TIER}`);
  console.log(`tick range:         ${TICK_LOWER} .. ${TICK_UPPER} (concentrated, ~-11%/+9% band)`);
  console.log(`USDC deposited:     ${formatUnits(amountsDeposited.usdc, USDC_DECIMALS)}`);
  console.log(`WETH deposited:     ${formatUnits(amountsDeposited.weth, WETH_DECIMALS)} (source: ${wethSource})`);
  console.log(
    `gas spent (real):   ${formatEther(gasSpent)} ETH${
      wethSource === "deposit-fallback" ? " — excludes the WETH deposit()'s ETH value, gas only" : ""
    }`,
  );
  console.log(`quote 1 WETH ->     ${formatUnits(quotes.wethToUsdc, USDC_DECIMALS)} USDC`);
  console.log(`quote 1,000 USDC -> ${formatUnits(quotes.usdcToWeth, WETH_DECIMALS)} WETH`);
  console.log(
    `demo swap 10 USDC ->     ${formatUnits(demoSwapImpact.usdcToWethOut, WETH_DECIMALS)} WETH ` +
      `(impact ${Number(demoSwapImpact.usdcToWethImpactBps) / 100}%)`,
  );
  console.log(
    `demo swap ${formatUnits(DEMO_SWAP_WETH, WETH_DECIMALS)} WETH -> ${formatUnits(demoSwapImpact.wethToUsdcOut, USDC_DECIMALS)} USDC ` +
      `(impact ${Number(demoSwapImpact.wethToUsdcImpactBps) / 100}%)`,
  );
  console.log(`transactions:`);
  for (const [label, hash] of Object.entries(txHashes)) {
    console.log(`  ${label}: ${hash}`);
  }

  const result: SeedPoolResult = {
    poolAddress,
    quotes,
    demoSwapImpact,
    createdThisRun: true,
    txHashes,
    amountsDeposited,
    wethSource,
  };
  if (writeArtifactFile) await writeArtifact(result);
  return result;
}

async function main() {
  const connection = await network.create();
  await seedPool(connection);
}

/**
 * Guards the standalone-CLI invocation below so it fires ONLY when `hardhat run` was pointed at
 * THIS file directly (`pnpm seed:fork` / `pnpm seed:sepolia`) — never as a side effect of another
 * script `import`ing {seedPool} (Task 10b's scripts/deploy.ts does exactly that). Without this
 * guard, importing this module would unconditionally run its own `network.create()` + full pool
 * seed as an uncontrolled side effect: on an EDR fork that means a SECOND, entirely independent
 * forked chain that the importing script's own connection and deployed contracts never see —
 * silently wasted gas and, worse, console output interleaved with the importer's own.
 *
 * Hardhat's `run` task does not put the script path at `process.argv[1]` (that slot is
 * hardhat's own CLI entry point), so the usual `import.meta.url === process.argv[1]` entrypoint
 * check does not apply here. Scanning the full `argv` for an entry that resolves to this file's
 * own path is robust to where in the invocation Hardhat's script argument lands.
 */
const scriptPath = fileURLToPath(import.meta.url);
const isDirectInvocation = process.argv.some((arg) => {
  try {
    return path.resolve(arg) === scriptPath;
  } catch {
    return false;
  }
});

if (isDirectInvocation) {
  main().catch((err) => {
    console.error("\nseedPool.ts failed:");
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  });
}
