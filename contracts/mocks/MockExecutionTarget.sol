// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {IExecutionTarget} from "../interfaces/IExecutionTarget.sol";

/**
 * @title MockExecutionTarget
 * @notice Recording stand-in for the real Aave V3 / Uniswap V3 adapters, used ONLY to assert
 * that {NetSettler} forwards a proof-verified aggregate net — and nothing else, and only once
 * per epoch. It performs no trade and holds no funds; the real adapters land in Tasks 7-8.
 */
contract MockExecutionTarget is IExecutionTarget {
    uint256 public callCount;
    uint256 public lastAgentId;
    uint256 public lastEpoch;
    uint256 public lastNetAmount;
    uint256 public lastMinOut;
    bool public lastNetIsBuy;
    address public lastCaller;

    /// @inheritdoc IExecutionTarget
    function executeNet(
        uint256 agentId,
        uint256 epoch,
        uint256 netAmount,
        bool netIsBuy,
        uint256 minOut
    ) external override {
        callCount += 1;
        lastAgentId = agentId;
        lastEpoch = epoch;
        lastNetAmount = netAmount;
        lastNetIsBuy = netIsBuy;
        lastMinOut = minOut;
        lastCaller = msg.sender;
    }
}
