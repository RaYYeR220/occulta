// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {IAavePool} from "../interfaces/IAavePool.sol";

/**
 * @title AaveAdapter
 * @notice Thin, owner-gated wrapper that lets Occulta's settled, plaintext net orders act on
 * the REAL, unmodified Aave V3 `Pool` — supply, withdraw, borrow, repay, and read back the
 * resulting account health.
 *
 * @dev Aave is not modified, extended, or forked anywhere in this contract: every mutating
 * function is a `pool.<...>` call against the Pool address handed in at construction, with no
 * intervening logic beyond an `approve` and an owner check. That is the entire point of an
 * "adapter" in this product — Occulta adds confidentiality upstream of this boundary (see
 * {IExecutionTarget}), and hands the public protocols exactly what they already accept from
 * anyone else.
 *
 * Nothing confidential happens here. This contract only ever sees plaintext: by the time a net
 * order reaches an execution path at all, `settle` in {NetSettler} has already proof-verified
 * and revealed it on-chain. Nox is not imported.
 *
 * This contract does NOT itself implement {IExecutionTarget} — it exposes Aave's own
 * supply/withdraw/borrow/repay primitives directly, with no opinion on how a `netAmount` /
 * `netIsBuy` pair maps onto them (that mapping is a strategy decision, not an Aave-integration
 * one, and is out of scope here). Composing this adapter behind an {IExecutionTarget}
 * implementation, if and where that composition belongs, is Task 10's job.
 *
 * Access control mirrors {OccultaVault}: the adapter holds real funds and real Aave positions,
 * so every mutating entry point is `onlyOwner`. The owner is meant to be the settler or the
 * agent runtime driving it — never a human admin in steady-state operation. {sweep} is the
 * adapter's only exit for plain ERC-20 balances (what {withdraw} and {borrow} land on it) back
 * to that owner or wherever it directs; {supply} and {repay} are the only paths back into Aave.
 */
contract AaveAdapter is Ownable {
    using SafeERC20 for IERC20;

    /// @dev Aave V3 removed stable-rate borrowing entirely; passing `1` reverts inside the
    /// Pool. Variable rate is therefore the only valid mode and is hardcoded, not a parameter.
    uint256 private constant VARIABLE_RATE_MODE = 2;

    /// @dev No referral program is integrated; Aave's own docs list `0` as "no referral".
    uint16 private constant REFERRAL_CODE = 0;

    /// @notice The real Aave V3 Pool this adapter trades against. Set once at deployment so
    /// the same contract can point at Sepolia in tests and at mainnet in production, and is
    /// never guessed or hardcoded in this file.
    IAavePool public immutable pool;

    /// @notice Emitted after a successful {supply}.
    event Supplied(address indexed asset, uint256 amount);

    /// @notice Emitted after a successful {withdraw}; `received` is what the Pool actually sent.
    event Withdrawn(address indexed asset, uint256 requested, uint256 received);

    /// @notice Emitted after a successful {borrow}.
    event Borrowed(address indexed asset, uint256 amount);

    /// @notice Emitted after a successful {repay}; `paid` is what the Pool actually pulled.
    event Repaid(address indexed asset, uint256 requested, uint256 paid);

    /// @notice Emitted after a successful {sweep}.
    event Swept(address indexed asset, address indexed to, uint256 amount);

    /// @notice Thrown when constructed against the zero-address Pool.
    error AaveAdapterZeroPool();

    /// @notice Thrown when `asset` is the zero address.
    error AaveAdapterZeroAsset();

    /// @notice Thrown when a recipient address is the zero address.
    error AaveAdapterZeroRecipient();

    /// @notice Thrown when `amount` is zero — Aave itself rejects zero-amount calls, but
    /// failing fast here keeps the revert reason specific to this contract.
    error AaveAdapterZeroAmount();

    /// @notice Thrown by {renounceOwnership}: this adapter holds real funds and real Aave
    /// positions gated behind `onlyOwner`, so ownership must never be dropped to `address(0)`.
    error RenounceDisabled();

    /**
     * @param pool_ The real Aave V3 Pool. Never `address(0)`.
     * @param initialOwner_ The settler/agent runtime authorized to drive this adapter.
     */
    constructor(IAavePool pool_, address initialOwner_) Ownable(initialOwner_) {
        require(address(pool_) != address(0), AaveAdapterZeroPool());
        pool = pool_;
    }

    /**
     * @notice Renouncing ownership is permanently disabled.
     * @dev Every mutating entry point (supply/withdraw/borrow/repay/sweep) is `onlyOwner`;
     * dropping the owner to `address(0)` would freeze this adapter's funds and Aave position
     * with no recovery. `transferOwnership` stays intact so the executor can be handed control.
     */
    function renounceOwnership() public pure override {
        revert RenounceDisabled();
    }

    /**
     * @notice Supplies `amount` of `asset`, already held by this adapter, into Aave.
     * @dev Approves the Pool for exactly `amount` via `forceApprove` (safe even if a prior
     * approval was left standing) and calls `Pool.supply(asset, amount, address(this), 0)` — the
     * adapter itself is `onBehalfOf`, so the resulting aTokens and collateral accrue to it.
     */
    function supply(address asset, uint256 amount) external onlyOwner {
        require(asset != address(0), AaveAdapterZeroAsset());
        require(amount > 0, AaveAdapterZeroAmount());

        IERC20(asset).forceApprove(address(pool), amount);
        pool.supply(asset, amount, address(this), REFERRAL_CODE);

        emit Supplied(asset, amount);
    }

    /**
     * @notice Withdraws `amount` of `asset` from Aave back to this adapter.
     * @dev `amount == type(uint256).max` withdraws the adapter's full aToken balance for
     * `asset`, per Aave's own convention.
     * @return received The amount of `asset` actually sent by the Pool.
     */
    function withdraw(address asset, uint256 amount) external onlyOwner returns (uint256 received) {
        require(asset != address(0), AaveAdapterZeroAsset());
        require(amount > 0, AaveAdapterZeroAmount());

        received = pool.withdraw(asset, amount, address(this));

        emit Withdrawn(asset, amount, received);
    }

    /**
     * @notice Borrows `amount` of `asset` against this adapter's existing Aave collateral.
     * @dev Always variable-rate (`interestRateMode = 2`) — Aave V3 has no stable-rate mode
     * left to pass. Borrowed funds and the resulting debt both land on this adapter.
     */
    function borrow(address asset, uint256 amount) external onlyOwner {
        require(asset != address(0), AaveAdapterZeroAsset());
        require(amount > 0, AaveAdapterZeroAmount());

        pool.borrow(asset, amount, VARIABLE_RATE_MODE, REFERRAL_CODE, address(this));

        emit Borrowed(asset, amount);
    }

    /**
     * @notice Repays `amount` of this adapter's variable-rate debt in `asset`.
     * @dev `amount == type(uint256).max` repays the full outstanding debt. Either way, the Pool
     * only ever pulls what is actually owed (`paid`), which can be less than `amount` — so the
     * approval is reset to zero immediately after the call rather than left standing on the Pool.
     * Requires this adapter to hold enough `asset` to cover what Aave pulls.
     * @return paid The amount of debt actually repaid.
     */
    function repay(address asset, uint256 amount) external onlyOwner returns (uint256 paid) {
        require(asset != address(0), AaveAdapterZeroAsset());
        require(amount > 0, AaveAdapterZeroAmount());

        IERC20(asset).forceApprove(address(pool), amount);
        paid = pool.repay(asset, amount, VARIABLE_RATE_MODE, address(this));
        IERC20(asset).forceApprove(address(pool), 0);

        emit Repaid(asset, amount, paid);
    }

    /**
     * @notice Sends `amount` of `asset` currently sitting on this adapter's own balance — not a
     * Pool position — to `to`.
     * @dev {borrow} and {withdraw} land plain ERC-20 balances on this adapter with no further
     * transfer; without this function that capital has nowhere to go except back into Aave via
     * {supply} or {repay}. `to` is deliberately unrestricted (not forced to `owner()`) so it can
     * point at the vault or settler that funded this adapter in the first place.
     */
    function sweep(address asset, address to, uint256 amount) external onlyOwner {
        require(asset != address(0), AaveAdapterZeroAsset());
        require(to != address(0), AaveAdapterZeroRecipient());
        require(amount > 0, AaveAdapterZeroAmount());

        IERC20(asset).safeTransfer(to, amount);

        emit Swept(asset, to, amount);
    }

    /**
     * @notice This adapter's current Aave health factor, WAD-scaled (1e18).
     * @dev Forwarded verbatim from `Pool.getUserAccountData` — Aave itself, not this contract,
     * is what special-cases zero debt to `type(uint256).max` rather than dividing by zero. A
     * healthy leveraged position reads above `1e18`; at or below it is liquidatable.
     */
    function healthFactor() external view returns (uint256) {
        (, , , , , uint256 hf) = pool.getUserAccountData(address(this));
        return hf;
    }

    /**
     * @notice This adapter's aggregate Aave position across every asset it holds or owes.
     * @dev `totalCollateralBase` / `totalDebtBase` / `availableBorrowsBase` are in the oracle
     * base currency (USD, 8 decimals); `healthFactor` is WAD-scaled, see {healthFactor}.
     */
    function accountData()
        external
        view
        returns (
            uint256 totalCollateralBase,
            uint256 totalDebtBase,
            uint256 availableBorrowsBase,
            uint256 healthFactor_
        )
    {
        (totalCollateralBase, totalDebtBase, availableBorrowsBase, , , healthFactor_) = pool
            .getUserAccountData(address(this));
    }
}
