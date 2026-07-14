// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

/**
 * @title IExecutionTarget
 * @notice The seam between Occulta's confidential netting and the public protocols it trades on.
 *
 * @dev {NetSettler} hands the aggregate net order — and nothing else — to an implementation of
 * this interface once, per epoch, after it has verified the decryption proofs on-chain. The
 * value that arrives here is therefore a *proven* plaintext, not an off-chain claim.
 *
 * The real adapters over Aave V3 and Uniswap V3 implement this interface (Tasks 7-8) and are
 * wired into the settler at deployment (Task 10). The settler deliberately knows nothing about
 * them: it must not grow protocol-specific logic, and no depositor-level information exists on
 * this side of the boundary to leak into one.
 */
interface IExecutionTarget {
    /**
     * @notice Executes an epoch's aggregate net order against the public protocols.
     * @dev MUST only be callable by the settler that owns the epoch. Every argument is public by
     * construction: the swap that lands on Uniswap/Aave discloses the same size and direction.
     * @param agentId The strategy agent whose epoch is being executed.
     * @param epoch The epoch whose net is being executed.
     * @param netAmount The proof-verified aggregate net magnitude. Never an individual intent.
     * @param netIsBuy Direction of the aggregate order: `true` = buy, `false` = sell.
     * @param minOut Slippage bound for the resulting swap, supplied by the agent runtime.
     */
    function executeNet(
        uint256 agentId,
        uint256 epoch,
        uint256 netAmount,
        bool netIsBuy,
        uint256 minOut
    ) external;
}
