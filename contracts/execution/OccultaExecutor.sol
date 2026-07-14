// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {IExecutionTarget} from "../interfaces/IExecutionTarget.sol";
import {AaveAdapter} from "../adapters/AaveAdapter.sol";
import {UniswapAdapter} from "../adapters/UniswapAdapter.sol";

/**
 * @title OccultaExecutor
 * @notice Implements {IExecutionTarget}: takes {NetSettler}'s proof-verified, plaintext
 * aggregate net order and routes it through the REAL, unmodified Aave V3 `Pool` and Uniswap V3
 * `SwapRouter02` — one swap, one Aave leg, nothing else. Neither protocol is called through any
 * fork or reimplementation of its own code: every mutating call this contract makes is one hop
 * through {AaveAdapter} or {UniswapAdapter}, and those adapters only ever call the genuine
 * deployed Pool / SwapRouter02 in turn. Aave and Uniswap are called here, never modified.
 *
 * @dev Why the collateral asset is WETH and the settlement asset is USDC, not the other way
 * round: on ETH Sepolia's shared Aave V3 deployment, the Aave-USDC reserve is already over its
 * supply cap (see {AaveAdapter}'s and {UniswapAdapter}'s own fork-test notes for the on-chain
 * evidence) — `Pool.supply(USDC, ...)` genuinely reverts, for any amount, from any caller. That
 * is a live constraint of the real protocol on this testnet, not a design preference, and this
 * contract does not attempt to design around it. Aave-WETH carries no such cap. Depositors fund
 * and settle in USDC — it is the confidential vault's asset and the unit {NetSettler} nets in —
 * but the only asset this deployment can actually park as Aave collateral is WETH. A net BUY
 * therefore converts settlement USDC into WETH before it ever reaches Aave, and a net SELL
 * converts Aave WETH back into USDC before it leaves this contract.
 *
 * A consequence worth stating plainly: `netAmount`'s unit depends on direction, because each
 * leg starts from a different asset. A BUY's `netAmount` is USDC — the capital this contract
 * already holds to deploy. A SELL's `netAmount` is WETH — the collateral amount to withdraw
 * from Aave. This contract does not convert between the two; the agent runtime that computed
 * the net off-chain is responsible for expressing it in the unit the direction requires. That
 * runtime is also the only party {settle} ever proof-verifies a plaintext from, so this is a
 * property of the caller's contract, not an ambiguity in this one.
 *
 * Nothing confidential happens here, and Nox is never imported: by the time {executeNet} is
 * called at all, {NetSettler-settle} has already proof-verified and publicly revealed the
 * plaintext net on-chain. This contract only ever sees that plaintext.
 *
 * Ownership. {AaveAdapter} and {UniswapAdapter} gate every mutating entry point `onlyOwner`, so
 * this contract must be their owner for {executeNet} to be able to drive them at all — that
 * transfer happens once, after deployment (a chicken-and-egg this contract's own constructor
 * cannot resolve, since its address does not exist until after the adapters do). This contract
 * is deliberately NOT the owner of itself in any circular sense: its own {sweep} is gated by a
 * separate, ordinary `Ownable` admin, kept apart from {executeNet}'s `settler` authorization so
 * neither role can be used to impersonate the other.
 */
contract OccultaExecutor is IExecutionTarget, Ownable {
    using SafeERC20 for IERC20;

    /// @notice The Aave adapter this executor drives. Must be owned by this contract.
    AaveAdapter public immutable aaveAdapter;

    /// @notice The Uniswap adapter this executor drives. Must be owned by this contract.
    UniswapAdapter public immutable uniswapAdapter;

    /// @notice The settlement/borrow asset — Aave-USDC on Sepolia (6 decimals). A BUY's
    /// `netAmount` is denominated in this asset.
    address public immutable usdc;

    /// @notice The collateral asset — Aave-WETH on Sepolia (18 decimals). A SELL's `netAmount`
    /// is denominated in this asset.
    address public immutable weth;

    /// @notice The single Uniswap V3 fee tier this executor trades through.
    uint24 public immutable fee;

    /// @notice The only address permitted to call {executeNet} — the {NetSettler} instance that
    /// owns this executor's epochs. Never the world: an unauthenticated caller could otherwise
    /// drive real Aave/Uniswap execution at will, on funds that are not theirs.
    address public immutable settler;

    /// @notice Emitted after a successful {executeNet}. `resultAmount` is the WETH supplied to
    /// Aave on a buy, or the USDC landed back on this contract on a sell.
    event Executed(
        uint256 indexed agentId,
        uint256 indexed epoch,
        bool netIsBuy,
        uint256 netAmount,
        uint256 resultAmount
    );

    /// @notice Emitted after a successful {sweep}.
    event Swept(address indexed token, address indexed to, uint256 amount);

    /// @notice Thrown when constructed against a zero address for any required dependency.
    error OccultaExecutorZeroAddress();

    /// @notice Thrown when {executeNet} is called by anyone but {settler}.
    error OccultaExecutorNotSettler(address caller);

    /// @notice Thrown when {executeNet}'s `netAmount` is zero. {IExecutionTarget} guarantees a
    /// non-zero net is what {NetSettler-settle} forwards, but this contract does not rely on
    /// that guarantee and fails fast on its own.
    error OccultaExecutorZeroNetAmount();

    /// @notice Thrown when `sweep`'s recipient is the zero address.
    error OccultaExecutorZeroRecipient();

    /// @notice Thrown when `sweep`'s `amount` is zero.
    error OccultaExecutorZeroAmount();

    /// @notice Thrown by {renounceOwnership}: the admin role gates {sweep} over real balances,
    /// so ownership must never be dropped to `address(0)`.
    error RenounceDisabled();

    /**
     * @param aaveAdapter_ The Aave adapter this executor drives. Its ownership must be
     * transferred to this contract's address separately, after this constructor returns.
     * @param uniswapAdapter_ The Uniswap adapter this executor drives. Same ownership caveat.
     * @param usdc_ Aave-USDC — the settlement asset, and a BUY's swap input.
     * @param weth_ Aave-WETH — the collateral asset, and a SELL's swap input.
     * @param fee_ The Uniswap V3 fee tier this executor trades through (1% / 10000 on Sepolia —
     * see {UniswapAdapter}'s fork test for why the usual 3000 tier is unusable here).
     * @param settler_ The {NetSettler} instance authorized to call {executeNet}.
     * @param initialOwner_ Administrator authorized to {sweep} stray balances off this contract.
     */
    constructor(
        AaveAdapter aaveAdapter_,
        UniswapAdapter uniswapAdapter_,
        address usdc_,
        address weth_,
        uint24 fee_,
        address settler_,
        address initialOwner_
    ) Ownable(initialOwner_) {
        require(
            address(aaveAdapter_) != address(0) &&
                address(uniswapAdapter_) != address(0) &&
                usdc_ != address(0) &&
                weth_ != address(0) &&
                settler_ != address(0),
            OccultaExecutorZeroAddress()
        );
        aaveAdapter = aaveAdapter_;
        uniswapAdapter = uniswapAdapter_;
        usdc = usdc_;
        weth = weth_;
        fee = fee_;
        settler = settler_;
    }

    /**
     * @notice Renouncing ownership is permanently disabled.
     * @dev The `Ownable` admin gates {sweep}, the only exit for a net SELL's proceeds that land
     * on this contract; dropping the owner to `address(0)` would strand them. `transferOwnership`
     * stays intact so the admin role can be rotated.
     */
    function renounceOwnership() public pure override {
        revert RenounceDisabled();
    }

    /// @dev Restricts a call to the configured {settler} — the only party {NetSettler-settle}
    /// ever proof-verifies a plaintext net from before forwarding it here.
    modifier onlySettler() {
        require(msg.sender == settler, OccultaExecutorNotSettler(msg.sender));
        _;
    }

    /**
     * @inheritdoc IExecutionTarget
     * @dev `netIsBuy` selects which single leg runs; `agentId` and `epoch` are not used in the
     * routing decision, only echoed back in {Executed} so an off-chain observer can correlate
     * this call with the {NetSettler-Settled} event that triggered it.
     */
    function executeNet(
        uint256 agentId,
        uint256 epoch,
        uint256 netAmount,
        bool netIsBuy,
        uint256 minOut
    ) external override onlySettler {
        require(netAmount > 0, OccultaExecutorZeroNetAmount());

        uint256 resultAmount = netIsBuy ? _executeBuy(netAmount, minOut) : _executeSell(netAmount, minOut);

        emit Executed(agentId, epoch, netIsBuy, netAmount, resultAmount);
    }

    /**
     * @dev Net BUY: USDC -> WETH on Uniswap, then the received WETH -> Aave as collateral.
     * `netAmount` USDC must already sit on this contract (funded upstream by the vault's unwrap
     * bridge in production; funded directly by a faucet in this task's fork test) before this
     * runs. Both adapters only ever act on funds already resident on their own balance, so each
     * leg's output is swept onward before the next leg is invoked.
     */
    function _executeBuy(uint256 netAmount, uint256 minOut) private returns (uint256 wethSupplied) {
        IERC20(usdc).safeTransfer(address(uniswapAdapter), netAmount);
        uint256 wethReceived = uniswapAdapter.swapExactIn(usdc, weth, fee, netAmount, minOut);

        uniswapAdapter.sweep(weth, address(aaveAdapter), wethReceived);
        aaveAdapter.supply(weth, wethReceived);

        return wethReceived;
    }

    /**
     * @dev Net SELL: withdraw `netAmount` WETH collateral from Aave, then swap the withdrawn
     * WETH -> USDC on Uniswap. The resulting USDC lands back on this contract for the upstream
     * re-wrap into the confidential vault — this contract does not push it any further itself.
     */
    function _executeSell(uint256 netAmount, uint256 minOut) private returns (uint256 usdcReceived) {
        uint256 wethWithdrawn = aaveAdapter.withdraw(weth, netAmount);

        aaveAdapter.sweep(weth, address(uniswapAdapter), wethWithdrawn);
        usdcReceived = uniswapAdapter.swapExactIn(weth, usdc, fee, wethWithdrawn, minOut);

        uniswapAdapter.sweep(usdc, address(this), usdcReceived);
    }

    /**
     * @notice Sends `amount` of `token` currently sitting on this contract's own balance to `to`.
     * @dev Mirrors {AaveAdapter-sweep} / {UniswapAdapter-sweep}. A net SELL's proceeds land here
     * (see {_executeSell}) with no further on-chain step of their own, so this is their exit —
     * gated by this contract's `Ownable` admin, deliberately separate from {executeNet}'s
     * `settler` authorization.
     */
    function sweep(address token, address to, uint256 amount) external onlyOwner {
        require(token != address(0), OccultaExecutorZeroAddress());
        require(to != address(0), OccultaExecutorZeroRecipient());
        require(amount > 0, OccultaExecutorZeroAmount());

        IERC20(token).safeTransfer(to, amount);

        emit Swept(token, to, amount);
    }
}
