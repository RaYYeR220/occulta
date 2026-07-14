// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {ISwapRouter02} from "../interfaces/ISwapRouter02.sol";

/**
 * @title UniswapAdapter
 * @notice Thin, owner-gated wrapper that lets Occulta's settled, plaintext net orders act on the
 * REAL, unmodified Uniswap V3 `SwapRouter02` — a single-hop exact-input swap, and nothing else.
 *
 * @dev Uniswap is not modified, extended, or forked anywhere in this contract: {swapExactIn} is
 * one `router.exactInputSingle` call against the router address handed in at construction, with
 * no intervening logic beyond an approve/reset and an owner check. That is the entire point of
 * an "adapter" in this product — Occulta adds confidentiality upstream of this boundary (see
 * {IExecutionTarget}), and hands the public protocol exactly what it already accepts from anyone
 * else.
 *
 * Nothing confidential happens here. This contract only ever sees plaintext: by the time a net
 * order reaches an execution path at all, `settle` in {NetSettler} has already proof-verified
 * and revealed it on-chain. Nox is not imported.
 *
 * This contract does NOT itself implement {IExecutionTarget} — mapping a `netAmount`/`netIsBuy`
 * pair onto a concrete `tokenIn`/`tokenOut`/`fee` triple is a strategy decision, not a
 * Uniswap-integration one, and is out of scope here. Composing this adapter behind an
 * {IExecutionTarget} implementation, if and where that composition belongs, is Task 10's job.
 *
 * Access control mirrors {AaveAdapter}: the adapter holds real funds mid-flight, so every
 * mutating entry point is `onlyOwner`. The owner is meant to be the settler or the agent runtime
 * driving it — never a human admin in steady-state operation. {sweep} is the adapter's only exit
 * for ERC-20 balances that {swapExactIn} lands on it.
 */
contract UniswapAdapter is Ownable {
    using SafeERC20 for IERC20;

    /// @notice The real Uniswap V3 SwapRouter02 this adapter trades against. Set once at
    /// deployment so the same contract can point at Sepolia in tests and at mainnet in
    /// production, and is never guessed or hardcoded in this file.
    ISwapRouter02 public immutable router;

    /// @notice Emitted after a successful {swapExactIn}.
    event Swapped(
        address indexed tokenIn,
        address indexed tokenOut,
        uint24 fee,
        uint256 amountIn,
        uint256 amountOut
    );

    /// @notice Emitted after a successful {sweep}.
    event Swept(address indexed token, address indexed to, uint256 amount);

    /// @notice Thrown when constructed against the zero-address router.
    error UniswapAdapterZeroRouter();

    /// @notice Thrown when a token address argument (`tokenIn`, `tokenOut`, or `sweep`'s `token`)
    /// is the zero address.
    error UniswapAdapterZeroToken();

    /// @notice Thrown when `sweep`'s recipient is the zero address.
    error UniswapAdapterZeroRecipient();

    /// @notice Thrown when `swapExactIn`'s `amountIn` is zero. A zero-size net is never a real
    /// order — {IExecutionTarget} guarantees `netAmount` is non-zero before this adapter is ever
    /// reached, but this contract does not rely on that guarantee and fails fast on its own.
    error UniswapAdapterZeroAmountIn();

    /// @notice Thrown when `swapExactIn`'s `minOut` is zero. This adapter never places an
    /// unbounded-slippage swap: `exactInputSingle`'s `amountOutMinimum` is `minOut` verbatim, so
    /// a zero here would accept literally any output, including a swap drained to nothing by a
    /// sandwich. Callers must always supply a real bound computed off a quote.
    error UniswapAdapterZeroMinOut();

    /// @notice Thrown when `sweep`'s `amount` is zero.
    error UniswapAdapterZeroAmount();

    /**
     * @param router_ The real Uniswap V3 SwapRouter02. Never `address(0)`.
     * @param initialOwner_ The settler/agent runtime authorized to drive this adapter.
     */
    constructor(ISwapRouter02 router_, address initialOwner_) Ownable(initialOwner_) {
        require(address(router_) != address(0), UniswapAdapterZeroRouter());
        router = router_;
    }

    /**
     * @notice Swaps `amountIn` of `tokenIn`, already held by this adapter, for `tokenOut` via a
     * single `fee`-tier Uniswap V3 pool, requiring at least `minOut` of `tokenOut` back.
     * @dev Approves the router for exactly `amountIn` via `forceApprove` (safe even if a prior
     * approval was left standing), swaps with `recipient = address(this)` and no price limit
     * (`sqrtPriceLimitX96 = 0`), then resets the router's allowance to zero. `exactInputSingle`
     * always pulls exactly `amountIn` — unlike Aave's `repay`, there is no partial-pull case to
     * account for — so the reset is defense in depth against a future router change, not a
     * response to an observed standing allowance.
     * @return amountOut The amount of `tokenOut` actually received.
     */
    function swapExactIn(
        address tokenIn,
        address tokenOut,
        uint24 fee,
        uint256 amountIn,
        uint256 minOut
    ) external onlyOwner returns (uint256 amountOut) {
        require(tokenIn != address(0) && tokenOut != address(0), UniswapAdapterZeroToken());
        require(amountIn > 0, UniswapAdapterZeroAmountIn());
        require(minOut > 0, UniswapAdapterZeroMinOut());

        IERC20(tokenIn).forceApprove(address(router), amountIn);

        amountOut = router.exactInputSingle(
            ISwapRouter02.ExactInputSingleParams({
                tokenIn: tokenIn,
                tokenOut: tokenOut,
                fee: fee,
                recipient: address(this),
                amountIn: amountIn,
                amountOutMinimum: minOut,
                sqrtPriceLimitX96: 0
            })
        );

        IERC20(tokenIn).forceApprove(address(router), 0);

        emit Swapped(tokenIn, tokenOut, fee, amountIn, amountOut);
    }

    /**
     * @notice Sends `amount` of `token` currently sitting on this adapter's own balance to `to`.
     * @dev {swapExactIn} lands its output on this adapter with no further transfer; without this
     * function that capital has nowhere to go except into another swap. `to` is deliberately
     * unrestricted (not forced to `owner()`) so it can point at the vault or settler that funded
     * this adapter in the first place.
     */
    function sweep(address token, address to, uint256 amount) external onlyOwner {
        require(token != address(0), UniswapAdapterZeroToken());
        require(to != address(0), UniswapAdapterZeroRecipient());
        require(amount > 0, UniswapAdapterZeroAmount());

        IERC20(token).safeTransfer(to, amount);

        emit Swept(token, to, amount);
    }
}
