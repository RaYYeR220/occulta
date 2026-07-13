// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {euint256, externalEuint256} from "@iexec-nox/nox-protocol-contracts/contracts/sdk/Nox.sol";

/**
 * @title IOccultaVault
 * @notice Confidential, asynchronous tokenized vault: depositors queue encrypted deposit /
 * redeem requests, and the vault's Ownable owner (the autonomous agent runtime) settles them
 * at a moment of its choosing. An adaptation of EIP-7540 (async ERC-4626) where every amount
 * is an encrypted `euint256` handle instead of a plaintext `uint256`.
 *
 * @dev Flow differences from the plaintext EIP-7540:
 *  - All amounts are encrypted. Only the vault's `owner()` (the agent) and the request's own
 *    `controller` can decrypt a given pending/claimable bucket off-chain, via the Nox ACL.
 *  - `REQUEST_ID` is a constant (`0`) — EIP-7540's "singleton" mode, where each controller has
 *    at most one pending and one claimable request per flow. A second `requestDeposit` (or
 *    `requestRedeem`) before settlement simply accumulates into the same bucket.
 *  - Shares are minted/burned at `approveDeposit` / `approveRedeem` time (fulfillment), not at
 *    claim time — the claim is then a pure transfer, requiring no further NAV computation.
 */
interface IOccultaVault {
    // ============ Events ============

    event DepositRequest(
        address indexed controller,
        address indexed owner,
        uint256 indexed requestId,
        address sender,
        euint256 assets
    );
    event RedeemRequest(
        address indexed controller,
        address indexed owner,
        uint256 indexed requestId,
        address sender,
        euint256 shares
    );

    event DepositApproved(address indexed owner, euint256 assets);
    event RedeemApproved(address indexed owner, euint256 shares);

    event DepositClaimed(address indexed controller, address indexed receiver, euint256 shares);
    event RedeemClaimed(address indexed controller, address indexed receiver, euint256 assets);

    // ============ Metadata ============

    /// @notice Address of the underlying confidential asset (ERC-7984) accepted by the vault.
    function asset() external view returns (address);

    /// @notice Total amount of the underlying asset held by the vault (encrypted).
    function confidentialTotalAssets() external view returns (euint256);

    // ============ Request Phase ============

    /**
     * @notice Transfers `encAssets` from `owner_` into the vault and queues them as a pending
     * deposit request for `controller`.
     * @dev Prerequisites: `owner_` must have called `asset.setOperator(vault, until)` and
     * granted this vault Nox ACL access to the balance handle backing `encAssets`.
     * @return requestId Always `0` (singleton mode).
     */
    function requestDeposit(
        externalEuint256 encAssets,
        bytes calldata inputProof,
        address controller,
        address owner_
    ) external returns (uint256 requestId);

    /**
     * @notice Same as the external-input variant, but takes an already-registered `euint256`
     * handle. The caller must already hold Nox ACL access to `assets`.
     */
    function requestDeposit(
        euint256 assets,
        address controller,
        address owner_
    ) external returns (uint256 requestId);

    /**
     * @notice Transfers `encShares` from `owner_` into the vault (escrow) and queues them as a
     * pending redeem request for `controller`.
     */
    function requestRedeem(
        externalEuint256 encShares,
        bytes calldata inputProof,
        address controller,
        address owner_
    ) external returns (uint256 requestId);

    /// @notice Same as the external-input variant, but takes an already-registered handle.
    function requestRedeem(
        euint256 shares,
        address controller,
        address owner_
    ) external returns (uint256 requestId);

    // ============ Approve Phase (onlyOwner) ============

    /**
     * @notice Settles up to `assets` of `owner_`'s pending deposit bucket at the current
     * productive NAV, minting the resulting shares into escrow at the vault.
     * @dev Never reverts on over-approval: if `assets` exceeds the current pending amount, the
     * settlement is a silent no-op (pending untouched, nothing credited). Only callable by the
     * vault's Ownable `owner()`.
     */
    function approveDeposit(euint256 assets, address owner_) external;

    /**
     * @notice Settles up to `shares` of `owner_`'s pending redeem bucket at the current
     * productive NAV, burning the escrowed shares and reserving the resulting assets.
     * @dev Same silent-no-op behavior as {approveDeposit} on over-approval. Only callable by
     * the vault's Ownable `owner()`.
     */
    function approveRedeem(euint256 shares, address owner_) external;

    // ============ Claim Phase ============

    /**
     * @notice Claims `controller`'s full claimable deposit bucket: transfers the escrowed
     * shares (minted at `approveDeposit` time) to `receiver`.
     */
    function deposit(address receiver, address controller) external returns (euint256 shares);

    /**
     * @notice Claims `controller`'s full claimable redeem bucket: transfers the reserved
     * assets (earmarked at `approveRedeem` time) to `receiver`.
     */
    function redeem(address receiver, address controller) external returns (euint256 assets);

    // ============ Views ============

    /// @notice Encrypted amount of assets currently pending deposit approval for `controller`.
    function pendingDepositRequest(address controller) external view returns (euint256);

    /// @notice Encrypted amount of assets currently claimable (post-approval) for `controller`.
    function claimableDepositRequest(address controller) external view returns (euint256);

    /// @notice Encrypted amount of shares currently pending redeem approval for `controller`.
    function pendingRedeemRequest(address controller) external view returns (euint256);

    /// @notice Encrypted amount of shares currently claimable (post-approval) for `controller`.
    function claimableRedeemRequest(address controller) external view returns (euint256);

    /// @notice Returns whether `who` is allowed to decrypt `handle` off-chain.
    function isAllowedFor(euint256 handle, address who) external view returns (bool);
}
