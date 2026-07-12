// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {Nox, euint256, externalEuint256} from "@iexec-nox/nox-protocol-contracts/contracts/sdk/Nox.sol";
import {IStrategyRegistry} from "../interfaces/IStrategyRegistry.sol";

/**
 * @title StrategyRegistry
 * @notice Holds sealed (encrypted) strategy policies published by strategists, so an
 * autonomous off-chain runtime can trade on their behalf without ever revealing the
 * policy to the chain, to followers, or to the strategist's own future transactions.
 *
 * @dev This is the security core of the product: the policy is the alpha, and it must
 * never leak.
 *
 * ACL decision: every policy handle gets exactly two grants — `Nox.allowThis` (so the
 * registry can keep reusing the handle in later transactions, e.g. to read it back) and
 * `Nox.allow(slot, runtime)` (so the named off-chain TEE runtime can decrypt it). Nothing
 * else. In particular the strategist who submitted the policy is NOT granted decrypt
 * rights on the stored handle by this contract: registering an agent hands the policy to
 * the runtime and the chain forgets it from that point on. The strategist obviously still
 * holds their own plaintext copy off-chain (they authored it), but this contract does not
 * hand them a second, on-chain route back into the sealed value. `allowPublicDecryption`
 * is never called on a policy handle, and followers are never granted access at all.
 */
contract StrategyRegistry is IStrategyRegistry {
    /// @notice Thrown when `registerAgent` is called with an empty policy array.
    error EmptyPolicy();

    /// @notice Thrown when the `policy` and `proofs` arrays have different lengths.
    error LengthMismatch();

    /// @notice Thrown when referencing an `agentId` that was never registered.
    error UnknownAgent(uint256 agentId);

    struct Agent {
        AgentMeta meta;
        euint256[] policy;
    }

    Agent[] private _agents;

    /// @dev Reverts with `UnknownAgent` unless `agentId` refers to a registered agent.
    modifier onlyKnownAgent(uint256 agentId) {
        require(agentId < _agents.length, UnknownAgent(agentId));
        _;
    }

    /// @inheritdoc IStrategyRegistry
    function registerAgent(
        string calldata name,
        string calldata mandate,
        address runtime,
        externalEuint256[] calldata policy,
        bytes[] calldata proofs
    ) external returns (uint256 agentId) {
        require(policy.length > 0, EmptyPolicy());
        require(policy.length == proofs.length, LengthMismatch());

        agentId = _agents.length;
        Agent storage agent = _agents.push();
        agent.meta = AgentMeta({
            strategist: msg.sender,
            runtime: runtime,
            name: name,
            mandate: mandate,
            active: true
        });

        for (uint256 i = 0; i < policy.length; i++) {
            euint256 slot = Nox.fromExternal(policy[i], proofs[i]);
            Nox.allowThis(slot);
            Nox.allow(slot, runtime);
            agent.policy.push(slot);
        }

        emit AgentRegistered(agentId, msg.sender, runtime, name);
    }

    /// @inheritdoc IStrategyRegistry
    function policyOf(
        uint256 agentId,
        uint256 idx
    ) external view onlyKnownAgent(agentId) returns (euint256) {
        return _agents[agentId].policy[idx];
    }

    /// @inheritdoc IStrategyRegistry
    function metaOf(
        uint256 agentId
    ) external view onlyKnownAgent(agentId) returns (AgentMeta memory) {
        return _agents[agentId].meta;
    }

    /// @inheritdoc IStrategyRegistry
    function agentCount() external view returns (uint256) {
        return _agents.length;
    }

    /// @inheritdoc IStrategyRegistry
    function isRuntimeAllowed(
        uint256 agentId,
        uint256 idx
    ) external view onlyKnownAgent(agentId) returns (bool) {
        Agent storage agent = _agents[agentId];
        return Nox.isAllowed(agent.policy[idx], agent.meta.runtime);
    }

    /// @inheritdoc IStrategyRegistry
    function isAllowedFor(euint256 handle, address who) external view returns (bool) {
        return Nox.isAllowed(handle, who);
    }
}
