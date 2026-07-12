// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {euint256, externalEuint256} from "@iexec-nox/nox-protocol-contracts/contracts/sdk/Nox.sol";

/// @notice Registry of sealed (encrypted) strategy policies for autonomous trading agents.
interface IStrategyRegistry {
    /**
     * @notice Public metadata for a registered agent.
     * @dev `name` and `mandate` are intentionally public: followers judge an agent by its
     * mandate and public performance, never by its sealed policy.
     * @param strategist The address that registered the agent.
     * @param runtime The off-chain TEE runtime authorized to decrypt the agent's policy.
     * @param name Public display name of the agent.
     * @param mandate Public description of the agent's strategy mandate.
     * @param active Whether the agent is currently active.
     */
    struct AgentMeta {
        address strategist;
        address runtime;
        string name;
        string mandate;
        bool active;
    }

    /// @notice Emitted when a new agent is registered.
    /// @param agentId The identifier of the newly registered agent.
    /// @param strategist The address that registered the agent.
    /// @param runtime The off-chain TEE runtime authorized to decrypt the agent's policy.
    /// @param name Public display name of the agent.
    event AgentRegistered(
        uint256 indexed agentId,
        address indexed strategist,
        address indexed runtime,
        string name
    );

    /**
     * @notice Registers a new agent with a sealed policy.
     * @dev Policy slot convention (fixed length, indices are meaningful):
     *   0 = targetWeightBps      target allocation weight, in basis points
     *   1 = rebalanceTriggerBps  drift that triggers a rebalance, in basis points
     *   2 = maxLeverageBps       maximum leverage, in basis points
     *   3 = riskCapBps           maximum risk budget, in basis points
     * @param name Public display name of the agent.
     * @param mandate Public description of the agent's strategy mandate.
     * @param runtime Address of the off-chain TEE runtime allowed to decrypt the policy.
     * @param policy Externally-encrypted policy values, indexed per the slot convention above.
     * @param proofs Encryption proofs, one per `policy` entry, matched by index.
     * @return agentId The identifier of the newly registered agent.
     */
    function registerAgent(
        string calldata name,
        string calldata mandate,
        address runtime,
        externalEuint256[] calldata policy,
        bytes[] calldata proofs
    ) external returns (uint256 agentId);

    /// @notice Returns the sealed policy handle at slot `idx` for `agentId`.
    function policyOf(uint256 agentId, uint256 idx) external view returns (euint256);

    /// @notice Returns the public metadata for `agentId`.
    function metaOf(uint256 agentId) external view returns (AgentMeta memory);

    /// @notice Returns the number of registered agents.
    function agentCount() external view returns (uint256);

    /// @notice Returns whether `agentId`'s runtime is allowed to decrypt policy slot `idx`.
    function isRuntimeAllowed(uint256 agentId, uint256 idx) external view returns (bool);

    /// @notice Returns whether `who` is allowed to decrypt `handle` off-chain.
    function isAllowedFor(euint256 handle, address who) external view returns (bool);
}
