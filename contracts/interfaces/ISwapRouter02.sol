// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

/**
 * @title ISwapRouter02
 * @notice Minimal slice of the real Uniswap V3 `SwapRouter02` — only the entry point
 * {UniswapAdapter} calls. Not a full Uniswap interface, and deliberately so: this file exists to
 * type-check calls against the genuinely deployed router, never to reimplement or wrap its
 * behavior.
 *
 * @dev The original `SwapRouter` is not deployed on Sepolia — only `SwapRouter02`, whose
 * `ExactInputSingleParams` has NO `deadline` field (unlike the classic V3 router). The struct
 * below is that real, deployed shape, not the older textbook one.
 */
interface ISwapRouter02 {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    /// @notice Swaps exactly `params.amountIn` of `params.tokenIn` for `params.tokenOut` through
    /// a single `params.fee`-tier pool, sending at least `params.amountOutMinimum` of the output
    /// to `params.recipient`.
    function exactInputSingle(
        ExactInputSingleParams calldata params
    ) external payable returns (uint256 amountOut);
}
