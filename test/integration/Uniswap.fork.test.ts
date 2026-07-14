import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { network } from "hardhat";
import { parseAbi } from "viem";

/**
 * Integration test for {UniswapAdapter} against the REAL, deployed Uniswap V3 protocol on ETH
 * Sepolia — run on a fork so no real testnet ETH is required, but every contract touched
 * (SwapRouter02, QuoterV2, Factory, NonfungiblePositionManager, faucet, Aave-USDC, Aave-WETH) is
 * the genuine on-chain deployment. Zero mocks.
 *
 * Run with: pnpm test:fork
 * (equivalent to `hardhat test --network sepoliaFork test/integration/Uniswap.fork.test.ts`, part
 * of the same `test:fork` script that also runs the Aave fork test)
 *
 * Pool choice, and why we seed our own: there is no deeply-liquid existing Uniswap pool on
 * Sepolia whose BOTH tokens are Aave-supported — the deep pools pair a *different* USDC and the
 * canonical WETH9, neither of which Aave accepts here. Since Task 7's Aave adapter and this
 * Uniswap adapter are deliberately meant to compose over the SAME assets, this test creates and
 * seeds a real Aave-USDC/Aave-WETH pool itself via the real `NonfungiblePositionManager` —
 * genuine Uniswap V3 code, genuine tokens, genuine liquidity, just provisioned by us instead of
 * inherited from someone else's deployment. Task 9 scripts the same seeding on live Sepolia.
 *
 * Fee tier, and why 10000 (1%) rather than the "usual" 3000 (0.3%): a direct on-chain query of
 * the real `UniswapV3Factory.getPool(USDC, WETH, fee)` on live Sepolia (not the fork — the
 * genuine chain, read-only, before writing this test) found that the 500 and 3000 tiers for this
 * exact pair are NOT virgin — someone else already called `createPool`/`initialize` against them.
 * The 3000-fee pool already carries real (if tiny) liquidity at a wildly wrong price (~2.43M
 * USDC per WETH — a live, on-chain instance of exactly the decimals mixup this task's `★
 * Uniswap gotchas` section warns about, apparently from another team building against the same
 * shared testnet assets), and `createAndInitializePoolIfNecessary` is a no-op on price once a
 * pool is already initialized — our carefully-derived `sqrtPriceX96` would simply be discarded.
 * The 10000-fee tier for this pair, by contrast, returned the zero address (genuinely
 * un-created) and `factory.feeAmountTickSpacing(10000) == 200`, confirming it is an enabled,
 * clean tier. Seeding there gives this test full, uncontaminated control over the initial price
 * — still real Uniswap V3, real tokens, real self-provisioned liquidity, just at the fee tier
 * nobody else on this shared testnet had touched yet.
 */

/** Verified live Uniswap V3 addresses on ETH Sepolia (chainId 11155111). */
const SWAP_ROUTER_02 = "0x3bFA4769FB09eefC5a80d6E87c3B9C650f7Ae48E" as const;
const QUOTER_V2 = "0xEd1f6473345F45b75F8179591dd5bA1888cf2FB3" as const;
const FACTORY = "0x0227628f3F023bb0B980b67D528571c95c6DaC1c" as const;
const POSITION_MANAGER = "0x1238536071E1c677A632429e3655c799b22cDA52" as const;

/** Same Aave-supported assets Task 7's AaveAdapter test uses — deliberate coherence. */
const FAUCET = "0xC959483DBa39aa9E78757139af0e9a2EDEb3f42D" as const;
const USDC = "0x94a9D9AC8a22534E3FaCa9F4e7F2E2cf85d5E4C8" as const; // 6 decimals
const WETH = "0xC558DBdd856501FCd9aaF1E62eae57A9F0629a3c" as const; // 18 decimals, payable deposit()

const FEE_TIER = 10000; // 1% — see "Fee tier" note above for why not the usual 3000.
// Uniswap's fixed tick spacing for the 1% fee tier is 200 — see the TICK_LOWER/TICK_UPPER
// derivation below.

/** Faucet is capped at 10,000 units/call (scaled by decimals); called twice for extra pool depth. */
const FAUCET_MINT = 10_000_000_000n; // 10,000 USDC per call
const USDC_SEED_DESIRED = 20_000_000_000n; // 20,000 USDC offered to the position

/** Wrapped from the fork's own pre-funded local ETH via the real Aave-WETH `deposit()` — no
 * real testnet ETH involved, same pattern as the Aave fork test. */
const WETH_SEED_DESIRED = 10_000_000_000_000_000_000n; // 10 WETH offered to the position

/**
 * `sqrtPriceX96` derivation for token0 = Aave-USDC (6 decimals), token1 = Aave-WETH (18
 * decimals), targeting a real-world price of 1 WETH = 3,000 USDC.
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
const priceNumerator = 10n ** 18n; // 1 WETH, raw (18 decimals)
const priceDenominator = 3000n * 10n ** 6n; // 3,000 USDC, raw (6 decimals)
const SQRT_PRICE_X96_USDC_WETH = isqrt((priceNumerator * Q192) / priceDenominator);

/** Wide, effectively full-range position for the 1% tier's tick spacing (200): the nearest
 * usable ticks to Uniswap's global MIN_TICK/MAX_TICK (-887272 / 887272) that are multiples of
 * 200 without exceeding that range (-887272 / 200 = -4436.36, so -4436 * 200 = -887200; mirrored
 * for the upper bound). */
const TICK_LOWER = -887200;
const TICK_UPPER = 887200;

const erc20Abi = parseAbi([
  "function balanceOf(address account) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
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

describe("UniswapAdapter — real Uniswap V3 on a Sepolia fork", () => {
  it(
    "seeds a real Aave-USDC/Aave-WETH pool, then swaps both directions through the genuine SwapRouter02",
    { timeout: 180_000 },
    async () => {
      const { viem } = await network.create();
      const [deployer, stranger] = await viem.getWalletClients();
      const publicClient = await viem.getPublicClient();

      // Sanity: our hardcoded token0/token1 assumption (USDC < WETH by address) must hold, or
      // the derived sqrtPriceX96 above is for the wrong pair orientation.
      assert.ok(
        BigInt(USDC) < BigInt(WETH),
        "expected USDC to sort as token0 — sqrtPriceX96 derivation assumes this order",
      );

      // 1. Real faucet, real token: mint USDC to the deployer (two calls — faucet caps each at
      // 10,000 units).
      await deployer.writeContract({
        address: FAUCET,
        abi: faucetAbi,
        functionName: "mint",
        args: [USDC, deployer.account.address, FAUCET_MINT],
      });
      await deployer.writeContract({
        address: FAUCET,
        abi: faucetAbi,
        functionName: "mint",
        args: [USDC, deployer.account.address, FAUCET_MINT],
      });

      const deployerUsdcAfterMint = await publicClient.readContract({
        address: USDC,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [deployer.account.address],
      });
      assert.equal(deployerUsdcAfterMint, USDC_SEED_DESIRED);

      // Wrap the fork's own local ETH into real Aave-WETH — no real testnet ETH involved.
      await deployer.writeContract({
        address: WETH,
        abi: wethAbi,
        functionName: "deposit",
        args: [],
        value: WETH_SEED_DESIRED,
      });

      // 2. Seed the pool: create + initialize at our derived price, then mint a wide-range
      // position. Both tokens approved to the real NonfungiblePositionManager first.
      await deployer.writeContract({
        address: USDC,
        abi: erc20Abi,
        functionName: "approve",
        args: [POSITION_MANAGER, USDC_SEED_DESIRED],
      });
      await deployer.writeContract({
        address: WETH,
        abi: erc20Abi,
        functionName: "approve",
        args: [POSITION_MANAGER, WETH_SEED_DESIRED],
      });

      await deployer.writeContract({
        address: POSITION_MANAGER,
        abi: positionManagerAbi,
        functionName: "createAndInitializePoolIfNecessary",
        args: [USDC, WETH, FEE_TIER, SQRT_PRICE_X96_USDC_WETH],
      });

      const latestBlock = await publicClient.getBlock();
      const deadline = latestBlock.timestamp + 3600n;

      await deployer.writeContract({
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
            amount0Desired: USDC_SEED_DESIRED,
            amount1Desired: WETH_SEED_DESIRED,
            amount0Min: 0n,
            amount1Min: 0n,
            recipient: deployer.account.address,
            deadline,
          },
        ],
      });

      // 3. The real factory now reports a real pool for this pair/fee.
      const poolAddress = await publicClient.readContract({
        address: FACTORY,
        abi: factoryAbi,
        functionName: "getPool",
        args: [USDC, WETH, FEE_TIER],
      });
      assert.notEqual(poolAddress, "0x0000000000000000000000000000000000000000");

      // 4. Quote WETH -> USDC via the real QuoterV2 (non-view; simulated, never called as a
      // plain on-chain view) and assert the price is sane — this proves the seeded pool price is
      // right, not absurd.
      const oneWeth = 10n ** 18n;
      const preSwapQuote = await publicClient.simulateContract({
        address: QUOTER_V2,
        abi: quoterAbi,
        functionName: "quoteExactInputSingle",
        args: [{ tokenIn: WETH, tokenOut: USDC, amountIn: oneWeth, fee: FEE_TIER, sqrtPriceLimitX96: 0n }],
        account: deployer.account,
      });
      const [quotedUsdcForOneWeth] = preSwapQuote.result;
      // Sane band around the 3,000 USDC/WETH seed price — generous enough to absorb this pool's
      // own price impact, tight enough to catch a wrong-order-of-magnitude sqrtPriceX96.
      assert.ok(
        quotedUsdcForOneWeth > 2_000_000_000n && quotedUsdcForOneWeth < 4_000_000_000n,
        `quote for 1 WETH should land near 3,000 USDC, got ${quotedUsdcForOneWeth.toString()} raw units`,
      );

      // 5. Deploy the real adapter against the real router; fund it; swap WETH -> USDC.
      const adapter = await viem.deployContract("UniswapAdapter", [
        SWAP_ROUTER_02,
        deployer.account.address,
      ]);

      const swapAmountWeth = oneWeth / 2n; // 0.5 WETH
      // Move the swap leg onto the adapter the same way {AaveAdapter}'s test funds its adapter:
      // a plain transfer (the adapter never pulls via `transferFrom` — it only acts on funds it
      // already holds — so no `approve` to the adapter itself is needed here).
      const wethTransferAbi = parseAbi(["function transfer(address to, uint256 amount) returns (bool)"]);
      await deployer.writeContract({
        address: WETH,
        abi: wethTransferAbi,
        functionName: "transfer",
        args: [adapter.address, swapAmountWeth],
      });

      const quoteBeforeFirstSwap = await publicClient.simulateContract({
        address: QUOTER_V2,
        abi: quoterAbi,
        functionName: "quoteExactInputSingle",
        args: [
          { tokenIn: WETH, tokenOut: USDC, amountIn: swapAmountWeth, fee: FEE_TIER, sqrtPriceLimitX96: 0n },
        ],
        account: deployer.account,
      });
      const [quotedUsdcOut] = quoteBeforeFirstSwap.result;
      const minUsdcOut = (quotedUsdcOut * 99n) / 100n; // 1% slippage tolerance

      const adapterUsdcBefore = await publicClient.readContract({
        address: USDC,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [adapter.address],
      });
      assert.equal(adapterUsdcBefore, 0n);

      await adapter.write.swapExactIn([WETH, USDC, FEE_TIER, swapAmountWeth, minUsdcOut], {
        account: deployer.account,
      });

      const adapterUsdcAfter = await publicClient.readContract({
        address: USDC,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [adapter.address],
      });
      assert.ok(adapterUsdcAfter >= minUsdcOut, "adapter should have received at least minOut USDC");
      assert.ok(adapterUsdcAfter > adapterUsdcBefore, "adapter's USDC balance should have increased");
      // Within a sane band of the pre-swap quote (execution happens moments later, same pool
      // state modulo this very trade, so it should track closely).
      assert.ok(
        adapterUsdcAfter >= (quotedUsdcOut * 98n) / 100n && adapterUsdcAfter <= (quotedUsdcOut * 102n) / 100n,
        `swap output ${adapterUsdcAfter.toString()} should be within 2% of the quote ${quotedUsdcOut.toString()}`,
      );

      // 7 (first leg). Router allowance for WETH is back to zero after the swap.
      const wethAllowanceAfterSwap = await publicClient.readContract({
        address: WETH,
        abi: erc20Abi,
        functionName: "allowance",
        args: [adapter.address, SWAP_ROUTER_02],
      });
      assert.equal(wethAllowanceAfterSwap, 0n);

      // 6. Swap the other direction: USDC -> WETH. The deployer's original USDC mint was fully
      // consumed seeding the pool (USDC was the limiting side of the mint — see the seed amounts
      // above), so mint a fresh batch from the real, permissionless faucet to fund this leg.
      const swapAmountUsdc = 1_000_000_000n; // 1,000 USDC
      await deployer.writeContract({
        address: FAUCET,
        abi: faucetAbi,
        functionName: "mint",
        args: [USDC, deployer.account.address, swapAmountUsdc],
      });
      const usdcTransferAbi = parseAbi(["function transfer(address to, uint256 amount) returns (bool)"]);
      await deployer.writeContract({
        address: USDC,
        abi: usdcTransferAbi,
        functionName: "transfer",
        args: [adapter.address, swapAmountUsdc],
      });

      const quoteBeforeSecondSwap = await publicClient.simulateContract({
        address: QUOTER_V2,
        abi: quoterAbi,
        functionName: "quoteExactInputSingle",
        args: [
          { tokenIn: USDC, tokenOut: WETH, amountIn: swapAmountUsdc, fee: FEE_TIER, sqrtPriceLimitX96: 0n },
        ],
        account: deployer.account,
      });
      const [quotedWethOut] = quoteBeforeSecondSwap.result;
      const minWethOut = (quotedWethOut * 99n) / 100n;

      const adapterWethBefore = await publicClient.readContract({
        address: WETH,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [adapter.address],
      });
      assert.equal(adapterWethBefore, 0n);

      await adapter.write.swapExactIn([USDC, WETH, FEE_TIER, swapAmountUsdc, minWethOut], {
        account: deployer.account,
      });

      const adapterWethAfter = await publicClient.readContract({
        address: WETH,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [adapter.address],
      });
      assert.ok(adapterWethAfter >= minWethOut, "adapter should have received at least minOut WETH");
      assert.ok(adapterWethAfter > adapterWethBefore, "adapter's WETH balance should have increased");
      assert.ok(
        adapterWethAfter >= (quotedWethOut * 98n) / 100n && adapterWethAfter <= (quotedWethOut * 102n) / 100n,
        `swap output ${adapterWethAfter.toString()} should be within 2% of the quote ${quotedWethOut.toString()}`,
      );

      // 7 (second leg). Router allowance for USDC is back to zero after the swap.
      const usdcAllowanceAfterSwap = await publicClient.readContract({
        address: USDC,
        abi: erc20Abi,
        functionName: "allowance",
        args: [adapter.address, SWAP_ROUTER_02],
      });
      assert.equal(usdcAllowanceAfterSwap, 0n);

      // 8. Access control: a non-owner is refused on every mutating entry point.
      await assert.rejects(
        adapter.write.swapExactIn([WETH, USDC, FEE_TIER, 1n, 1n], { account: stranger.account }),
        /OwnableUnauthorizedAccount/,
      );
      await assert.rejects(
        adapter.write.sweep([USDC, stranger.account.address, 1n], { account: stranger.account }),
        /OwnableUnauthorizedAccount/,
      );

      // 9. amountIn == 0 reverts with the adapter's own custom error, not a generic router
      // failure.
      await assert.rejects(
        adapter.write.swapExactIn([WETH, USDC, FEE_TIER, 0n, 1n], { account: deployer.account }),
        /UniswapAdapterZeroAmountIn/,
      );

      // sweep(): the WETH received from the second swap is not stuck on the adapter.
      await adapter.write.sweep([WETH, deployer.account.address, adapterWethAfter], {
        account: deployer.account,
      });
      const adapterWethAfterSweep = await publicClient.readContract({
        address: WETH,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [adapter.address],
      });
      assert.equal(adapterWethAfterSweep, 0n);
    },
  );
});
