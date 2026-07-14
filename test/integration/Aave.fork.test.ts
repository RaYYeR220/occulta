import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { network } from "hardhat";
import { parseAbi } from "viem";

/**
 * Integration test for {AaveAdapter} against the REAL, deployed Aave V3 protocol on ETH
 * Sepolia — run on a fork so no real testnet ETH is required, but every contract touched
 * (Pool, PoolDataProvider, faucet, Aave-USDC, Aave-WETH) is the genuine on-chain deployment.
 * Zero mocks.
 *
 * Run with: pnpm test:fork
 * (equivalent to `hardhat test --network sepoliaFork test/integration/Aave.fork.test.ts`)
 *
 * Asset choice, and why it deviates from a same-asset walkthrough: the shared Aave-USDC
 * reserve on this testnet deployment is a public faucet target for every team working against
 * it, and by the time this test was written its supply cap was already exceeded on-chain
 * (`PoolDataProvider.getReserveCaps` reports a 2,000,000,000 USDC cap against an actual
 * aToken totalSupply north of 3,900,000,000 units) — ANY further `supply(USDC, ...)` reverts
 * with Aave's own error string "51" (`SUPPLY_CAP_EXCEEDED`), regardless of amount. That is a
 * genuine, live constraint of the real protocol, not a bug in this test or the adapter, and
 * this suite is not in the business of raising Aave's risk parameters to work around it.
 * Aave-WETH's supply cap is 0 (uncapped), so collateral is posted in WETH instead — wrapped
 * from the fork's own pre-funded local ETH via the real `WETH9Mock.deposit()`, not the
 * faucet (which itself rejects WETH with "not mintable"; only USDC is faucet-mintable here).
 * Aave-USDC remains the borrow/repay leg: its borrow cap is 0 (uncapped), the reserve holds
 * ample real liquidity to lend from, and its faucet is exercised exactly as specified to fund
 * the repay leg. Every call below is still a real, unmodified Aave V3 Pool entry point.
 */

/** Verified live Aave V3 addresses on ETH Sepolia (chainId 11155111). */
const POOL = "0x6Ae43d3271ff6888e7Fc43Fd7321a503ff738951" as const;
const POOL_DATA_PROVIDER = "0x3e9708d80f7B3e43118013075F7e95CE3AB31F31" as const;
const FAUCET = "0xC959483DBa39aa9E78757139af0e9a2EDEb3f42D" as const;
const USDC = "0x94a9D9AC8a22534E3FaCa9F4e7F2E2cf85d5E4C8" as const;
const WETH = "0xC558DBdd856501FCd9aaF1E62eae57A9F0629a3c" as const;

/** Aave-USDC is 6 decimals; the faucet is capped at 10,000 units/call. Minted in full to
 * demonstrate the real, permissionless faucet, even though only a slice funds the repay leg. */
const FAUCET_MINT = 10_000_000_000n; // 10,000 USDC
/** Transferred into the adapter to cover the borrow leg's debt plus a few blocks of accrued
 * interest — {repay}'s `type(uint256).max` pulls exactly what Aave says is owed. */
const USDC_REPAY_FUNDING = 200_000_000n; // 200 USDC
const BORROW_AMOUNT = 100_000_000n; // 100 USDC

/** Wrapped from the fork's own local ETH balance via `WETH9Mock.deposit()` — no real testnet
 * ETH involved. Aave-WETH has no supply cap, unlike the shared USDC reserve. */
const WETH_SUPPLY_AMOUNT = 5_000_000_000_000_000_000n; // 5 WETH

const MAX_UINT256 = 2n ** 256n - 1n;

const erc20Abi = parseAbi([
  "function balanceOf(address account) view returns (uint256)",
  "function transfer(address to, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
]);

const faucetAbi = parseAbi([
  "function mint(address token, address to, uint256 amount) returns (uint256)",
]);

const wethAbi = parseAbi(["function deposit() payable"]);

const poolDataProviderAbi = parseAbi([
  "function getReserveTokensAddresses(address asset) view returns (address aTokenAddress, address stableDebtTokenAddress, address variableDebtTokenAddress)",
]);

describe("AaveAdapter — real Aave V3 on a Sepolia fork", () => {
  it(
    "supplies WETH collateral, borrows and repays real USDC, then withdraws — against the genuine Pool",
    { timeout: 180_000 },
    async () => {
      const { viem } = await network.create();
      const [deployer, stranger] = await viem.getWalletClients();
      const publicClient = await viem.getPublicClient();

      const adapter = await viem.deployContract("AaveAdapter", [POOL, deployer.account.address]);

      // 1. Real faucet, real token: mint USDC to the deployer.
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
      assert.equal(deployerUsdcAfterMint, FAUCET_MINT);

      // Fund the adapter with the USDC that will cover the repay leg.
      await deployer.writeContract({
        address: USDC,
        abi: erc20Abi,
        functionName: "transfer",
        args: [adapter.address, USDC_REPAY_FUNDING],
      });

      // Wrap the fork's own local ETH into real Aave-WETH (WETH9Mock) and fund the adapter.
      await deployer.writeContract({
        address: WETH,
        abi: wethAbi,
        functionName: "deposit",
        args: [],
        value: WETH_SUPPLY_AMOUNT,
      });
      await deployer.writeContract({
        address: WETH,
        abi: erc20Abi,
        functionName: "transfer",
        args: [adapter.address, WETH_SUPPLY_AMOUNT],
      });

      // 2. supply(WETH, amount) -> real aWETH minted to the adapter.
      await adapter.write.supply([WETH, WETH_SUPPLY_AMOUNT], { account: deployer.account });

      const [aWethAddress] = await publicClient.readContract({
        address: POOL_DATA_PROVIDER,
        abi: poolDataProviderAbi,
        functionName: "getReserveTokensAddresses",
        args: [WETH],
      });

      const aWethBalance = await publicClient.readContract({
        address: aWethAddress,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [adapter.address],
      });
      assert.ok(aWethBalance > 0n, "adapter should hold aWETH after supply");

      const [totalCollateralBase] = await adapter.read.accountData();
      assert.ok(totalCollateralBase > 0n, "collateral should be posted on Aave");

      // 3. Zero debt -> Aave's own sentinel for "no debt", not a computed ratio.
      const hfBeforeBorrow = await adapter.read.healthFactor();
      assert.equal(hfBeforeBorrow, MAX_UINT256);

      // 4. borrow(USDC, small) -> real debt against the WETH collateral, finite and healthy HF.
      await adapter.write.borrow([USDC, BORROW_AMOUNT], { account: deployer.account });

      const [, totalDebtBaseAfterBorrow] = await adapter.read.accountData();
      assert.ok(totalDebtBaseAfterBorrow > 0n, "debt should be posted on Aave after borrow");

      const hfAfterBorrow = await adapter.read.healthFactor();
      assert.ok(hfAfterBorrow < MAX_UINT256, "health factor must be finite once there is debt");
      assert.ok(hfAfterBorrow > 10n ** 18n, "a small borrow against ample collateral stays healthy");

      // 5. repay(USDC, max) -> debt back to ~0, health factor back to the zero-debt sentinel.
      await adapter.write.repay([USDC, MAX_UINT256], { account: deployer.account });

      const [, totalDebtBaseAfterRepay] = await adapter.read.accountData();
      assert.equal(totalDebtBaseAfterRepay, 0n);

      const hfAfterRepay = await adapter.read.healthFactor();
      assert.equal(hfAfterRepay, MAX_UINT256);

      // repay() must not leave a standing approval on the Pool once Aave has pulled what it's
      // owed — the sentinel amount (type(uint256).max) approved up front is far more than the
      // actual debt, so this is the check that the adapter cleans up after itself.
      const usdcAllowanceAfterRepay = await publicClient.readContract({
        address: USDC,
        abi: erc20Abi,
        functionName: "allowance",
        args: [adapter.address, POOL],
      });
      assert.equal(usdcAllowanceAfterRepay, 0n);

      // 6. withdraw(WETH, max) -> the supplied WETH (plus any accrued interest) comes back.
      const adapterWethBeforeWithdraw = await publicClient.readContract({
        address: WETH,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [adapter.address],
      });

      assert.equal(adapterWethBeforeWithdraw, 0n, "the adapter supplied its entire WETH balance");

      await adapter.write.withdraw([WETH, MAX_UINT256], { account: deployer.account });

      const adapterWethAfterWithdraw = await publicClient.readContract({
        address: WETH,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [adapter.address],
      });
      assert.ok(
        adapterWethAfterWithdraw >= WETH_SUPPLY_AMOUNT,
        "the full supplied principal (plus any accrued interest) should come back",
      );

      const aWethAfterWithdraw = await publicClient.readContract({
        address: aWethAddress,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [adapter.address],
      });
      assert.equal(aWethAfterWithdraw, 0n);

      // 7. sweep(WETH, owner, amount) -> the withdrawn WETH is not stuck on the adapter; it can
      // actually leave, back to whoever the owner (settler/agent) directs.
      await adapter.write.sweep([WETH, deployer.account.address, adapterWethAfterWithdraw], {
        account: deployer.account,
      });

      const adapterWethAfterSweep = await publicClient.readContract({
        address: WETH,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [adapter.address],
      });
      assert.equal(adapterWethAfterSweep, 0n);

      const deployerWethAfterSweep = await publicClient.readContract({
        address: WETH,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [deployer.account.address],
      });
      assert.ok(deployerWethAfterSweep >= WETH_SUPPLY_AMOUNT, "swept WETH should reach the owner");

      // 8. Access control: a non-owner is refused on every mutating entry point.
      await assert.rejects(
        adapter.write.supply([WETH, 1n], { account: stranger.account }),
        /OwnableUnauthorizedAccount/,
      );
      await assert.rejects(
        adapter.write.borrow([USDC, 1n], { account: stranger.account }),
        /OwnableUnauthorizedAccount/,
      );
      await assert.rejects(
        adapter.write.repay([USDC, 1n], { account: stranger.account }),
        /OwnableUnauthorizedAccount/,
      );
      await assert.rejects(
        adapter.write.withdraw([WETH, 1n], { account: stranger.account }),
        /OwnableUnauthorizedAccount/,
      );
      await assert.rejects(
        adapter.write.sweep([WETH, stranger.account.address, 1n], { account: stranger.account }),
        /OwnableUnauthorizedAccount/,
      );
    },
  );
});
