// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {IERC7984} from "@iexec-nox/nox-confidential-contracts/contracts/interfaces/IERC7984.sol";

import {OccultaVault} from "./OccultaVault.sol";

/**
 * @title OccultaVaultFactory
 * @notice Deploys one {OccultaVault} per strategy agent, so every agent in the Occulta
 * marketplace gets its own confidential capital pool with no human admin in the loop.
 *
 * @dev CREATE2 deployment: the resulting address is a deterministic function of
 * `(factory, salt, keccak256(creationCode ++ constructor args))`, so callers can know a
 * vault's address ahead of deployment via {predictVaultAddress}. `agentRuntime` becomes the
 * deployed vault's `Ownable` owner — the only account able to call `approveDeposit` /
 * `approveRedeem` on it.
 *
 * No on-chain registry is kept here: off-chain indexers enumerate deployed vaults from the
 * {VaultCreated} event.
 */
contract OccultaVaultFactory {
    /// @notice Thrown when `createVault` is called with a zero `agentRuntime`.
    error OccultaVaultFactoryZeroAgentRuntime();

    /**
     * @notice Emitted when a new vault is deployed.
     * @dev No `salt` field: the salt is a one-time deployment input, not part of the vault's
     * ongoing identity, and off-chain indexers key on `vault` directly.
     */
    event VaultCreated(
        address indexed vault,
        address indexed asset,
        address indexed agentRuntime,
        string name,
        string symbol
    );

    /**
     * @notice Deploys a new {OccultaVault} for `asset`, owned by `agentRuntime`.
     * @dev Reverts on the underlying CREATE2 collision if `salt` was already used with this
     * exact set of constructor arguments (the target address would already hold code).
     * @param asset The confidential ERC-7984 asset the vault accepts deposits in.
     * @param name Confidential share token name.
     * @param symbol Confidential share token symbol.
     * @param contractURI ERC-7572 contract metadata URI for the vault's share token.
     * @param agentRuntime The autonomous agent runtime that will own the vault (the only
     * account able to call `approveDeposit` / `approveRedeem`).
     * @param salt CREATE2 salt; combined with every other argument to determine the deployed
     * address, so a given `(salt, args)` pair can only ever be deployed once.
     * @return vault The address of the newly deployed vault.
     */
    function createVault(
        IERC7984 asset,
        string calldata name,
        string calldata symbol,
        string calldata contractURI,
        address agentRuntime,
        bytes32 salt
    ) external returns (address vault) {
        require(agentRuntime != address(0), OccultaVaultFactoryZeroAgentRuntime());

        vault = address(
            new OccultaVault{salt: salt}(asset, name, symbol, contractURI, agentRuntime)
        );

        emit VaultCreated(vault, address(asset), agentRuntime, name, symbol);
    }

    /**
     * @notice Computes the CREATE2 address a vault would be deployed to for a given set of
     * arguments, without deploying it.
     * @dev Standard CREATE2 derivation: `keccak256(0xff ++ factory ++ salt ++
     * keccak256(creationCode ++ constructor args))`, truncated to the low 20 bytes. Mirrors
     * {createVault}'s deployment exactly, so it stays correct only if that function's
     * constructor argument order ever changes in lockstep with this one.
     */
    function predictVaultAddress(
        IERC7984 asset,
        string calldata name,
        string calldata symbol,
        string calldata contractURI,
        address agentRuntime,
        bytes32 salt
    ) external view returns (address) {
        bytes32 initCodeHash = keccak256(
            abi.encodePacked(
                type(OccultaVault).creationCode,
                abi.encode(asset, name, symbol, contractURI, agentRuntime)
            )
        );
        bytes32 hash = keccak256(
            abi.encodePacked(bytes1(0xff), address(this), salt, initCodeHash)
        );
        return address(uint160(uint256(hash)));
    }
}
