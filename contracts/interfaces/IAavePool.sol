// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

/**
 * @title IAavePool
 * @notice Minimal slice of the real Aave V3 `Pool` contract — only the entry points
 * {AaveAdapter} calls. Not a full Aave interface, and deliberately so: this file exists to
 * type-check calls against the genuinely deployed Pool, never to reimplement or wrap its
 * behavior.
 */
interface IAavePool {
    /// @notice Supplies `amount` of `asset` into Aave on behalf of `onBehalfOf`.
    function supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode) external;

    /// @notice Withdraws `amount` of `asset` from Aave to `to`. `amount == type(uint256).max`
    /// withdraws the caller's full balance.
    function withdraw(address asset, uint256 amount, address to) external returns (uint256);

    /// @notice Borrows `amount` of `asset` against the caller's collateral. Aave V3 removed
    /// stable-rate borrowing, so `interestRateMode` MUST be `2` (variable) — `1` reverts.
    function borrow(
        address asset,
        uint256 amount,
        uint256 interestRateMode,
        uint16 referralCode,
        address onBehalfOf
    ) external;

    /// @notice Repays `amount` of `onBehalfOf`'s debt in `asset`. `amount ==
    /// type(uint256).max` repays the full outstanding debt.
    function repay(
        address asset,
        uint256 amount,
        uint256 interestRateMode,
        address onBehalfOf
    ) external returns (uint256);

    /**
     * @notice Aggregate account position across every asset `user` has supplied or borrowed.
     * @dev `*Base` values are denominated in the oracle base currency — USD with 8 decimals.
     * `healthFactor` is WAD-scaled (1e18); with zero debt Aave itself returns
     * `type(uint256).max` rather than a division by zero.
     */
    function getUserAccountData(
        address user
    )
        external
        view
        returns (
            uint256 totalCollateralBase,
            uint256 totalDebtBase,
            uint256 availableBorrowsBase,
            uint256 currentLiquidationThreshold,
            uint256 ltv,
            uint256 healthFactor
        );
}
