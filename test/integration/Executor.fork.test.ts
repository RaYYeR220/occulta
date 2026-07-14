import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { network } from "hardhat";
import { parseAbi } from "viem";

/**
 * Integration test for {OccultaExecutor} — the seam between NetSettler's proof-verified
 * aggregate net order and REAL, unmodified Aave V3 + Uniswap V3 on ETH Sepolia. Run on a fork
 * so no real testnet ETH is required, but every contract touched (Pool, PoolDataProvider,
 * SwapRouter02, QuoterV2, NonfungiblePositionManager, faucet, Aave-USDC, Aave-WETH) is the
 * genuine on-chain deployment. Zero mocks — the settler side is stood in by a plain EOA
 * (exactly what {IExecutionTarget} expects a caller to look like: an authorized address, no
 * particular contract shape), never a mock executor.
 *
 * Run with: pnpm test:fork
 * (equivalent to `hardhat test --network sepoliaFork test/integration/Executor.fork.test.ts`)
 *
 * Pool seeding below reproduces scripts/seedPool.ts's sqrtPriceX96 derivation and full-range
 * seed shape verbatim (same formula, same fee tier 10000, same reasoning for why 10000 and not
 * the squatted/mispriced 3000 tier — see Uniswap.fork.test.ts's header for the on-chain
 * evidence) rather than importing it, since that script is a standalone entrypoint with no
 * exports and each fork test spins up its own isolated EDR fork of live Sepolia state.
 */

/** Verified live addresses on ETH Sepolia (chainId 11155111). */
const POOL = "0x6Ae43d3271ff6888e7Fc43Fd7321a503ff738951" as const;
const POOL_DATA_PROVIDER = "0x3e9708d80f7B3e43118013075F7e95CE3AB31F31" as const;
const SWAP_ROUTER_02 = "0x3bFA4769FB09eefC5a80d6E87c3B9C650f7Ae48E" as const;
const QUOTER_V2 = "0xEd1f6473345F45b75F8179591dd5bA1888cf2FB3" as const;
const FACTORY = "0x0227628f3F023bb0B980b67D528571c95c6DaC1c" as const;
const POSITION_MANAGER = "0x1238536071E1c677A632429e3655c799b22cDA52" as const;
const FAUCET = "0xC959483DBa39aa9E78757139af0e9a2EDEb3f42D" as const;
const USDC = "0x94a9D9AC8a22534E3FaCa9F4e7F2E2cf85d5E4C8" as const; // 6 decimals
const WETH = "0xC558DBdd856501FCd9aaF1E62eae57A9F0629a3c" as const; // 18 decimals, payable deposit()

const FEE_TIER = 10000; // 1% — the un-squatted, correctly-priced tier for this pair on Sepolia.

/** Faucet is capped at 10,000 units/call (scaled by decimals). */
const FAUCET_MINT = 10_000_000_000n; // 10,000 USDC per call
const USDC_SEED_DESIRED = 20_000_000_000n; // 20,000 USDC offered to the seed position
const WETH_SEED_DESIRED = 10_000_000_000_000_000_000n; // 10 WETH offered to the seed position

/** `sqrtPriceX96` derivation for token0 = Aave-USDC (6 decimals), token1 = Aave-WETH (18
 * decimals), targeting 1 WETH = 3,000 USDC — reproduced verbatim from
 * test/integration/Uniswap.fork.test.ts / scripts/seedPool.ts. See either file's header for the
 * full derivation notes; unchanged here since re-deriving it is exactly the trap this task's
 * brief warns against. */
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

/** Wide, effectively full-range position for the 1% tier's tick spacing (200). */
const TICK_LOWER = -887200;
const TICK_UPPER = 887200;

/** Aggregate net orders this test drives through {OccultaExecutor}, standing in for the
 * agent-computed magnitudes {NetSettler-settle} would forward after proof verification. */
const BUY_NET_USDC = 500_000_000n; // 500 USDC — a net BUY's netAmount is USDC (settlement asset).
const SLIPPAGE_BPS = 100n; // 1% tolerance off the pre-trade QuoterV2 quote.

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

const poolDataProviderAbi = parseAbi([
  "function getReserveTokensAddresses(address asset) view returns (address aTokenAddress, address stableDebtTokenAddress, address variableDebtTokenAddress)",
]);

describe("OccultaExecutor — routes a net order through real Aave V3 + Uniswap V3 on a Sepolia fork", () => {
  it(
    "buys into WETH collateral, sells back out, and enforces auth + zero-net + slippage guards",
    { timeout: 240_000 },
    async () => {
      const { viem } = await network.create();
      const [deployer, settler, stranger] = await viem.getWalletClients();
      const publicClient = await viem.getPublicClient();

      assert.ok(
        BigInt(USDC) < BigInt(WETH),
        "expected USDC to sort as token0 — sqrtPriceX96 derivation assumes this order",
      );

      // 1. Seed the fee-10000 Aave-USDC/Aave-WETH pool — real NonfungiblePositionManager, real
      // faucet-minted USDC, real ETH-backed WETH, same derivation as scripts/seedPool.ts.
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
      await deployer.writeContract({
        address: WETH,
        abi: wethAbi,
        functionName: "deposit",
        args: [],
        value: WETH_SEED_DESIRED,
      });
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
      const seedBlock = await publicClient.getBlock();
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
            deadline: seedBlock.timestamp + 3600n,
          },
        ],
      });
      const poolAddress = await publicClient.readContract({
        address: FACTORY,
        abi: factoryAbi,
        functionName: "getPool",
        args: [USDC, WETH, FEE_TIER],
      });
      assert.notEqual(poolAddress, "0x0000000000000000000000000000000000000000");

      // 2. Deploy the real adapters, then OccultaExecutor wired to a plain EOA standing in for
      // NetSettler, then transfer both adapters' ownership to the executor.
      const aaveAdapter = await viem.deployContract("AaveAdapter", [POOL, deployer.account.address]);
      const uniswapAdapter = await viem.deployContract("UniswapAdapter", [
        SWAP_ROUTER_02,
        deployer.account.address,
      ]);
      const executor = await viem.deployContract("OccultaExecutor", [
        aaveAdapter.address,
        uniswapAdapter.address,
        USDC,
        WETH,
        FEE_TIER,
        settler.account.address,
        deployer.account.address,
      ]);
      await aaveAdapter.write.transferOwnership([executor.address], { account: deployer.account });
      await uniswapAdapter.write.transferOwnership([executor.address], { account: deployer.account });

      const [aWethAddress] = await publicClient.readContract({
        address: POOL_DATA_PROVIDER,
        abi: poolDataProviderAbi,
        functionName: "getReserveTokensAddresses",
        args: [WETH],
      });

      // 3. Net BUY: fund the executor with real faucet USDC (standing in for the vault's unwrap
      // bridge, exercised live in a later task) and drive executeNet as the settler EOA.
      await deployer.writeContract({
        address: FAUCET,
        abi: faucetAbi,
        functionName: "mint",
        args: [USDC, executor.address, BUY_NET_USDC],
      });
      const executorUsdcBeforeBuy = await publicClient.readContract({
        address: USDC,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [executor.address],
      });
      assert.equal(executorUsdcBeforeBuy, BUY_NET_USDC);

      const buyQuote = await publicClient.simulateContract({
        address: QUOTER_V2,
        abi: quoterAbi,
        functionName: "quoteExactInputSingle",
        args: [{ tokenIn: USDC, tokenOut: WETH, amountIn: BUY_NET_USDC, fee: FEE_TIER, sqrtPriceLimitX96: 0n }],
        account: deployer.account,
      });
      const [quotedWethOut] = buyQuote.result;
      const minWethOut = (quotedWethOut * (10_000n - SLIPPAGE_BPS)) / 10_000n;

      const collateralBeforeBuy = await aaveAdapter.read.accountData();
      assert.equal(collateralBeforeBuy[0], 0n, "adapter starts with no Aave collateral");

      const buyHash = await executor.write.executeNet([1n, 0n, BUY_NET_USDC, true, minWethOut], {
        account: settler.account,
      });
      const buyReceipt = await publicClient.waitForTransactionReceipt({ hash: buyHash });

      const buyEvents = await executor.getEvents.Executed(
        {},
        { fromBlock: buyReceipt.blockNumber, toBlock: buyReceipt.blockNumber },
      );
      assert.equal(buyEvents.length, 1);
      assert.equal(buyEvents[0].args.netIsBuy, true);
      assert.equal(buyEvents[0].args.netAmount, BUY_NET_USDC);
      const wethSupplied = buyEvents[0].args.resultAmount as bigint;
      assert.ok(wethSupplied >= minWethOut, "swapped WETH must respect the slippage bound");

      // (a) executor's USDC is fully deployed.
      const executorUsdcAfterBuy = await publicClient.readContract({
        address: USDC,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [executor.address],
      });
      assert.equal(executorUsdcAfterBuy, 0n);

      // (b) the swap happened on real Uniswap and the WETH was fully swept onward — nothing
      // stranded on the Uniswap adapter.
      const uniswapWethAfterBuy = await publicClient.readContract({
        address: WETH,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [uniswapAdapter.address],
      });
      assert.equal(uniswapWethAfterBuy, 0n);

      // (c) AaveAdapter now holds real WETH collateral in real Aave.
      const aWethBalanceAfterBuy = await publicClient.readContract({
        address: aWethAddress,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [aaveAdapter.address],
      });
      assert.ok(aWethBalanceAfterBuy > 0n, "AaveAdapter should hold aWETH after the buy");
      assert.ok(
        aWethBalanceAfterBuy >= wethSupplied,
        "aWETH balance should be at least what the executor reported supplying",
      );

      const collateralAfterBuy = await aaveAdapter.read.accountData();
      assert.ok(collateralAfterBuy[0] > 0n, "totalCollateralBase should be positive after the buy");

      // (d) allowances reset to zero — nothing left standing on the router or the Pool.
      const uniswapAllowanceAfterBuy = await publicClient.readContract({
        address: USDC,
        abi: erc20Abi,
        functionName: "allowance",
        args: [uniswapAdapter.address, SWAP_ROUTER_02],
      });
      assert.equal(uniswapAllowanceAfterBuy, 0n);
      const aaveAllowanceAfterBuy = await publicClient.readContract({
        address: WETH,
        abi: erc20Abi,
        functionName: "allowance",
        args: [aaveAdapter.address, POOL],
      });
      assert.equal(aaveAllowanceAfterBuy, 0n);

      // 4. Net SELL: unwind half of what was just supplied. A SELL's netAmount is WETH — the
      // collateral amount to withdraw — since that is the asset actually sitting on Aave.
      const sellNetWeth = wethSupplied / 2n;
      const sellQuote = await publicClient.simulateContract({
        address: QUOTER_V2,
        abi: quoterAbi,
        functionName: "quoteExactInputSingle",
        args: [{ tokenIn: WETH, tokenOut: USDC, amountIn: sellNetWeth, fee: FEE_TIER, sqrtPriceLimitX96: 0n }],
        account: deployer.account,
      });
      const [quotedUsdcOut] = sellQuote.result;
      const minUsdcOut = (quotedUsdcOut * (10_000n - SLIPPAGE_BPS)) / 10_000n;

      const sellHash = await executor.write.executeNet([1n, 1n, sellNetWeth, false, minUsdcOut], {
        account: settler.account,
      });
      const sellReceipt = await publicClient.waitForTransactionReceipt({ hash: sellHash });

      const sellEvents = await executor.getEvents.Executed(
        {},
        { fromBlock: sellReceipt.blockNumber, toBlock: sellReceipt.blockNumber },
      );
      assert.equal(sellEvents.length, 1);
      assert.equal(sellEvents[0].args.netIsBuy, false);
      assert.equal(sellEvents[0].args.netAmount, sellNetWeth);
      const usdcReceived = sellEvents[0].args.resultAmount as bigint;
      assert.ok(usdcReceived >= minUsdcOut, "swapped USDC must respect the slippage bound");

      // Aave collateral decreased...
      const aWethBalanceAfterSell = await publicClient.readContract({
        address: aWethAddress,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [aaveAdapter.address],
      });
      assert.ok(
        aWethBalanceAfterSell < aWethBalanceAfterBuy,
        "aWETH balance should have decreased after the sell",
      );
      const collateralAfterSell = await aaveAdapter.read.accountData();
      assert.ok(
        collateralAfterSell[0] < collateralAfterBuy[0],
        "totalCollateralBase should have decreased after the sell",
      );

      // ...and the resulting USDC landed back on the executor for the upstream re-wrap.
      const executorUsdcAfterSell = await publicClient.readContract({
        address: USDC,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [executor.address],
      });
      assert.equal(executorUsdcAfterSell, usdcReceived);

      const uniswapUsdcAfterSell = await publicClient.readContract({
        address: USDC,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [uniswapAdapter.address],
      });
      assert.equal(uniswapUsdcAfterSell, 0n, "nothing should be stranded on the Uniswap adapter");

      // 5. Auth: only the configured settler may call executeNet.
      await assert.rejects(
        executor.write.executeNet([1n, 2n, 1_000_000n, true, 1n], { account: stranger.account }),
        /OccultaExecutorNotSettler/,
      );
      await assert.rejects(
        executor.write.executeNet([1n, 2n, 1_000_000n, true, 1n], { account: deployer.account }),
        /OccultaExecutorNotSettler/,
      );

      // netAmount == 0 reverts even for the real settler.
      await assert.rejects(
        executor.write.executeNet([1n, 2n, 0n, true, 1n], { account: settler.account }),
        /OccultaExecutorZeroNetAmount/,
      );

      // 6. minOut enforcement: fund the executor again, then demand an absurdly high minOut —
      // the swap must revert, and the whole executeNet call must revert atomically (no
      // half-executed state: the USDC that would have been transferred to the Uniswap adapter
      // stays on the executor).
      const secondBuyUsdc = 100_000_000n; // 100 USDC
      await deployer.writeContract({
        address: FAUCET,
        abi: faucetAbi,
        functionName: "mint",
        args: [USDC, executor.address, secondBuyUsdc],
      });
      const executorUsdcBeforeFailedBuy = await publicClient.readContract({
        address: USDC,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [executor.address],
      });

      const impossibleMinOut = quotedWethOut * 1000n; // wildly more than the pool could ever pay
      await assert.rejects(
        executor.write.executeNet([1n, 3n, secondBuyUsdc, true, impossibleMinOut], {
          account: settler.account,
        }),
      );

      const executorUsdcAfterFailedBuy = await publicClient.readContract({
        address: USDC,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [executor.address],
      });
      assert.equal(
        executorUsdcAfterFailedBuy,
        executorUsdcBeforeFailedBuy,
        "a reverted executeNet must leave the executor's balance untouched — no half-executed state",
      );
      const uniswapUsdcAfterFailedBuy = await publicClient.readContract({
        address: USDC,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [uniswapAdapter.address],
      });
      assert.equal(uniswapUsdcAfterFailedBuy, 0n, "the failed swap must not have moved any USDC at all");
    },
  );
});
