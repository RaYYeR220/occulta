// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC7984} from "@iexec-nox/nox-confidential-contracts/contracts/interfaces/IERC7984.sol";
import {ERC7984} from "@iexec-nox/nox-confidential-contracts/contracts/token/ERC7984.sol";
import {
    Nox,
    ebool,
    euint256,
    externalEuint256
} from "@iexec-nox/nox-protocol-contracts/contracts/sdk/Nox.sol";

import {IOccultaVault} from "../interfaces/IOccultaVault.sol";

/**
 * @title OccultaVault
 * @notice The confidential capital pool of an Occulta strategy agent. Depositors queue
 * encrypted deposit/redeem requests against a confidential ERC-7984 asset (Occulta USDC);
 * the vault's owner — the autonomous agent runtime, never a human admin — settles those
 * requests at a moment of its choosing. Vault shares are themselves a confidential ERC-7984
 * token.
 *
 * @dev Adapts OZ's ERC-7540 draft reference design to encrypted amounts: the NAV conversion
 * happens at settlement (`approveDeposit` / `approveRedeem`), not at claim, so the share count
 * is deterministic from the agent's perspective as soon as a request is approved, and the
 * depositor-side claim is a pure transfer (no FHE convert/mint at claim time).
 *
 * Deposit lifecycle:
 *   1. {requestDeposit}: assets pulled into the vault; `_pendingDepositAssets[controller]` and
 *      the global `_totalPendingDepositAssets` counter both grow by the transferred amount.
 *   2. {approveDeposit}: the agent settles an amount of the controller's pending bucket.
 *      Shares are computed at the current productive NAV, minted to the vault itself (escrow),
 *      and the `(assets, shares)` pair moves into the controller's claimable bucket.
 *   3. {deposit}: a plain transfer of the escrowed shares from the vault to `receiver`.
 *
 * Redeem lifecycle (symmetric):
 *   1. {requestRedeem}: shares escrowed into the vault (`owner_` -> `address(this)`);
 *      `_pendingRedeemShares[controller]` grows by the escrowed amount.
 *   2. {approveRedeem}: the agent settles an amount of the controller's pending bucket. Assets
 *      are computed at the current productive NAV, the escrowed shares are burned, and the
 *      `(shares, assets)` pair moves into the controller's claimable bucket.
 *   3. {redeem}: a plain `_transferOut` of the reserved assets to `receiver`.
 *
 * Productive NAV = `confidentialTotalAssets() - _totalPendingDepositAssets`. Excluding the
 * pending pool keeps concurrent deposit requests from diluting one another and avoids the
 * `assets / (assets + 1) = 0` degeneracy on the very first deposit.
 *
 * Only the vault itself and its `owner()` can decrypt aggregated totals (`confidentialTotalSupply`,
 * `confidentialTotalAssets`) off-chain; individual depositors only ever see their own buckets.
 */
contract OccultaVault is ERC7984, IOccultaVault, Ownable {
    // ============ Storage ============

    uint256 internal constant REQUEST_ID = 0;

    IERC7984 private immutable _asset;

    /**
     * @dev Per EIP-7540, the deposit flow is tracked in assets (input unit) and the redeem flow
     * in shares. Conversion to the other unit happens only at settlement, against the live NAV.
     */
    mapping(address controller => euint256) private _pendingDepositAssets;
    mapping(address controller => euint256) private _claimableDepositAssets;
    /// @dev Shares pre-minted to the vault at `approveDeposit` time, paired with the matching
    ///      `_claimableDepositAssets[controller]` so the claim is a deterministic transfer.
    mapping(address controller => euint256) private _claimableDepositShares;

    mapping(address controller => euint256) private _pendingRedeemShares;
    mapping(address controller => euint256) private _claimableRedeemShares;
    /// @dev Assets reserved for the controller at `approveRedeem` time, paired with the
    ///      matching `_claimableRedeemShares[controller]`. Stays in the vault's balance until
    ///      claimed via {redeem}.
    mapping(address controller => euint256) private _claimableRedeemAssets;

    /**
     * @dev Running sum of deposit assets in the Pending state across every controller. Once the
     * agent `approveDeposit`s an amount, the share side is minted against it and this counter is
     * decremented — the corresponding assets become productive from that point.
     *
     * Invariant: `confidentialTotalAssets() - _totalPendingDepositAssets` equals the productive
     * capital (assets with shares already minted against them).
     */
    euint256 private _totalPendingDepositAssets;

    // ============ Errors ============

    error OccultaVaultInvalidAsset(address providedAsset);
    error OccultaVaultZeroAddress();
    /// @dev Thrown by every sync ERC-4626 entry point: this vault is async-only.
    error OccultaVaultSyncEntryPointDisabled();

    // ============ Constructor ============

    constructor(
        IERC7984 asset_,
        string memory name_,
        string memory symbol_,
        string memory contractURI_,
        address initialOwner_
    ) ERC7984(name_, symbol_, contractURI_) Ownable(initialOwner_) {
        require(address(asset_) != address(0), OccultaVaultInvalidAsset(address(0)));
        _asset = asset_;

        // Seed the inflight counter so the first `requestDeposit` can add to a known handle.
        euint256 zero = Nox.toEuint256(0);
        _totalPendingDepositAssets = zero;
        Nox.allowThis(zero);
        Nox.allow(zero, initialOwner_);
    }

    // ============ Disable sync entry points ============

    /**
     * @dev Per EIP-7540, sync entry points MUST revert on async-only vaults: depositors must go
     * through request / approve / claim instead.
     */
    function deposit(
        externalEuint256 /* encAssets */,
        bytes calldata /* inputProof */,
        address /* receiver */
    ) external pure returns (euint256) {
        revert OccultaVaultSyncEntryPointDisabled();
    }

    function mint(
        externalEuint256 /* encShares */,
        bytes calldata /* inputProof */,
        address /* receiver */
    ) external pure returns (euint256) {
        revert OccultaVaultSyncEntryPointDisabled();
    }

    function withdraw(
        externalEuint256 /* encAssets */,
        bytes calldata /* inputProof */,
        address /* receiver */,
        address /* owner_ */
    ) external pure returns (euint256) {
        revert OccultaVaultSyncEntryPointDisabled();
    }

    function redeem(
        externalEuint256 /* encShares */,
        bytes calldata /* inputProof */,
        address /* receiver */,
        address /* owner_ */
    ) external pure returns (euint256) {
        revert OccultaVaultSyncEntryPointDisabled();
    }

    // ============ Request Phase ============

    /// @inheritdoc IOccultaVault
    function requestDeposit(
        externalEuint256 encAssets,
        bytes calldata inputProof,
        address controller,
        address owner_
    ) external override returns (uint256) {
        return _requestDeposit(Nox.fromExternal(encAssets, inputProof), controller, owner_);
    }

    /// @inheritdoc IOccultaVault
    function requestDeposit(
        euint256 assets,
        address controller,
        address owner_
    ) external override returns (uint256) {
        require(
            Nox.isAllowed(assets, msg.sender),
            ERC7984UnauthorizedUseOfEncryptedAmount(assets, msg.sender)
        );
        return _requestDeposit(assets, controller, owner_);
    }

    /// @inheritdoc IOccultaVault
    function requestRedeem(
        externalEuint256 encShares,
        bytes calldata inputProof,
        address controller,
        address owner_
    ) external override returns (uint256) {
        return _requestRedeem(Nox.fromExternal(encShares, inputProof), controller, owner_);
    }

    /// @inheritdoc IOccultaVault
    function requestRedeem(
        euint256 shares,
        address controller,
        address owner_
    ) external override returns (uint256) {
        require(
            Nox.isAllowed(shares, msg.sender),
            ERC7984UnauthorizedUseOfEncryptedAmount(shares, msg.sender)
        );
        return _requestRedeem(shares, controller, owner_);
    }

    function _requestDeposit(
        euint256 assets,
        address controller,
        address owner_
    ) internal returns (uint256) {
        // `controller` is only used as a mapping key + Nox ACL target — checked here to avoid
        // locking funds in an unreachable bucket. A zero `owner_` is rejected downstream by
        // the asset's `confidentialTransferFrom` inside `_transferIn`.
        require(controller != address(0), OccultaVaultZeroAddress());
        require(isOperator(owner_, msg.sender), ERC7984UnauthorizedSpender(owner_, msg.sender));

        euint256 transferred = _transferIn(owner_, assets);

        euint256 newPending = Nox.add(_pendingDepositAssets[controller], transferred);
        _pendingDepositAssets[controller] = newPending;
        Nox.allowThis(newPending);
        Nox.allow(newPending, owner()); // the agent can observe
        Nox.allow(newPending, controller); // and the controller

        // Mirror the transfer in the global inflight counter: these assets sit in the vault but
        // no shares are minted against them yet, so they must not inflate the productive NAV.
        euint256 newInflight = Nox.add(_totalPendingDepositAssets, transferred);
        _totalPendingDepositAssets = newInflight;
        Nox.allowThis(newInflight);
        Nox.allow(newInflight, owner());

        emit DepositRequest(controller, owner_, REQUEST_ID, msg.sender, transferred);
        return REQUEST_ID;
    }

    function _requestRedeem(
        euint256 shares,
        address controller,
        address owner_
    ) internal returns (uint256) {
        require(controller != address(0), OccultaVaultZeroAddress());
        require(isOperator(owner_, msg.sender), ERC7984UnauthorizedSpender(owner_, msg.sender));

        // Escrow the shares: move them from owner_ to this vault.
        Nox.allowThis(shares);
        euint256 transferred = _transfer(owner_, address(this), shares);
        Nox.allowThis(transferred);

        euint256 newPending = Nox.add(_pendingRedeemShares[controller], transferred);
        _pendingRedeemShares[controller] = newPending;
        Nox.allowThis(newPending);
        Nox.allow(newPending, owner());
        Nox.allow(newPending, controller);

        emit RedeemRequest(controller, owner_, REQUEST_ID, msg.sender, transferred);
        return REQUEST_ID;
    }

    // ============ Approve Phase (onlyOwner) ============

    /**
     * @dev Settles `assets` of `owner_`'s pending deposit bucket. Converts the approved amount
     * to shares at the current productive NAV, mints those shares to the vault itself (escrow),
     * and stores the `(assets, shares)` pair on the claimable bucket.
     *
     * Uses {Nox.safeSub} so an approval bigger than the current pending is a no-op (pending
     * untouched, nothing credited) — never a revert, which would leak information about the
     * pending amount. {Nox.select} threads the success flag through every state update. The
     * productive NAV is snapshotted BEFORE the pending counter is decremented, so on the first
     * deposit (or whenever the controller's pending dominates) the productive totalAssets is
     * zero and shares are minted at the seed ratio.
     */
    /// @inheritdoc IOccultaVault
    function approveDeposit(euint256 assets, address owner_) external override onlyOwner {
        require(owner_ != address(0), OccultaVaultZeroAddress());
        Nox.allowThis(assets);

        (ebool success, euint256 newPending) = Nox.safeSub(_pendingDepositAssets[owner_], assets);
        newPending = Nox.select(success, newPending, _pendingDepositAssets[owner_]);
        euint256 approved = Nox.select(success, assets, Nox.toEuint256(0));

        // Snapshot productive NAV BEFORE decrementing _totalPendingDepositAssets: at this point
        // it still contains the full pending of this controller, correctly excluded from the
        // productive denominator.
        (euint256 assetsBefore, euint256 supplyBefore) = _snapshot();
        euint256 productiveAssets = Nox.sub(assetsBefore, _totalPendingDepositAssets);
        Nox.allowThis(productiveAssets);
        euint256 shares = _convertToShares(approved, productiveAssets, supplyBefore);

        // Mint the escrow shares to the vault. They increase totalSupply and sit on
        // `address(this)`'s balance until the controller claims via `deposit(receiver, c)`.
        _mint(address(this), shares);

        _pendingDepositAssets[owner_] = newPending;
        Nox.allowThis(newPending);
        Nox.allow(newPending, owner());
        Nox.allow(newPending, owner_);

        euint256 newTotalPending = Nox.sub(_totalPendingDepositAssets, approved);
        _totalPendingDepositAssets = newTotalPending;
        Nox.allowThis(newTotalPending);
        Nox.allow(newTotalPending, owner());

        euint256 newClaimableAssets = Nox.add(_claimableDepositAssets[owner_], approved);
        _claimableDepositAssets[owner_] = newClaimableAssets;
        Nox.allowThis(newClaimableAssets);
        Nox.allow(newClaimableAssets, owner());
        Nox.allow(newClaimableAssets, owner_);

        euint256 newClaimableShares = Nox.add(_claimableDepositShares[owner_], shares);
        _claimableDepositShares[owner_] = newClaimableShares;
        Nox.allowThis(newClaimableShares);
        Nox.allow(newClaimableShares, owner());
        Nox.allow(newClaimableShares, owner_);

        emit DepositApproved(owner_, approved);
    }

    /**
     * @dev Settles `shares` of `owner_`'s pending redeem bucket. Converts the approved amount to
     * assets at the current productive NAV, burns the escrowed shares, and stores the
     * `(shares, assets)` pair on the claimable bucket. Burning at settlement (not claim) keeps
     * `totalSupply` in sync with on-chain reality from the agent's settlement point onward.
     */
    /// @inheritdoc IOccultaVault
    function approveRedeem(euint256 shares, address owner_) external override onlyOwner {
        require(owner_ != address(0), OccultaVaultZeroAddress());
        Nox.allowThis(shares);

        (ebool success, euint256 newPending) = Nox.safeSub(_pendingRedeemShares[owner_], shares);
        newPending = Nox.select(success, newPending, _pendingRedeemShares[owner_]);
        euint256 approved = Nox.select(success, shares, Nox.toEuint256(0));

        // Snapshot productive NAV (excluding pending deposits — see `approveDeposit`; the
        // redeem side has no pending-assets bucket of its own).
        (euint256 assetsBefore, euint256 supplyBefore) = _snapshot();
        euint256 productiveAssets = Nox.sub(assetsBefore, _totalPendingDepositAssets);
        Nox.allowThis(productiveAssets);
        euint256 assetsOut = _convertToAssets(approved, productiveAssets, supplyBefore);
        Nox.allowThis(assetsOut);

        // Burn the escrowed shares now.
        _burn(address(this), approved);

        _pendingRedeemShares[owner_] = newPending;
        Nox.allowThis(newPending);
        Nox.allow(newPending, owner());
        Nox.allow(newPending, owner_);

        euint256 newClaimableShares = Nox.add(_claimableRedeemShares[owner_], approved);
        _claimableRedeemShares[owner_] = newClaimableShares;
        Nox.allowThis(newClaimableShares);
        Nox.allow(newClaimableShares, owner());
        Nox.allow(newClaimableShares, owner_);

        euint256 newClaimableAssets = Nox.add(_claimableRedeemAssets[owner_], assetsOut);
        _claimableRedeemAssets[owner_] = newClaimableAssets;
        Nox.allowThis(newClaimableAssets);
        Nox.allow(newClaimableAssets, owner());
        Nox.allow(newClaimableAssets, owner_);

        emit RedeemApproved(owner_, approved);
    }

    // ============ Claim Phase ============

    /**
     * @inheritdoc IOccultaVault
     * @dev Claims the escrowed shares from the vault to `receiver`. Shares were minted to the
     * vault at `approveDeposit` time; this call is a pure confidential transfer with no NAV
     * calculation. Resets both sides of the claimable bucket.
     */
    function deposit(address receiver, address controller) external override returns (euint256 shares) {
        require(controller != address(0), OccultaVaultZeroAddress());
        require(
            isOperator(controller, msg.sender),
            ERC7984UnauthorizedSpender(controller, msg.sender)
        );

        shares = _claimableDepositShares[controller];
        euint256 zero = Nox.toEuint256(0);
        _claimableDepositAssets[controller] = zero;
        _claimableDepositShares[controller] = zero;
        Nox.allowThis(zero);

        Nox.allowThis(shares);
        _transfer(address(this), receiver, shares);

        emit DepositClaimed(controller, receiver, shares);
    }

    /**
     * @inheritdoc IOccultaVault
     * @dev Claims the reserved assets from the vault to `receiver`. Assets were earmarked and
     * the escrowed shares were burned at `approveRedeem` time; this call is a pure
     * `_transferOut` with no NAV calculation. Resets both sides of the claimable bucket.
     */
    function redeem(address receiver, address controller) external override returns (euint256 assets) {
        require(controller != address(0), OccultaVaultZeroAddress());
        require(
            isOperator(controller, msg.sender),
            ERC7984UnauthorizedSpender(controller, msg.sender)
        );

        assets = _claimableRedeemAssets[controller];
        euint256 zero = Nox.toEuint256(0);
        _claimableRedeemShares[controller] = zero;
        _claimableRedeemAssets[controller] = zero;
        Nox.allowThis(zero);

        Nox.allowThis(assets);
        euint256 sent = _transferOut(receiver, assets);
        emit RedeemClaimed(controller, receiver, sent);
    }

    // ============ Views ============

    /// @inheritdoc IOccultaVault
    function asset() public view override returns (address) {
        return address(_asset);
    }

    /// @inheritdoc IOccultaVault
    function confidentialTotalAssets() public view override returns (euint256) {
        return _asset.confidentialBalanceOf(address(this));
    }

    /// @inheritdoc IOccultaVault
    function pendingDepositRequest(address controller) external view override returns (euint256) {
        return _pendingDepositAssets[controller];
    }

    /// @inheritdoc IOccultaVault
    function claimableDepositRequest(address controller) external view override returns (euint256) {
        return _claimableDepositAssets[controller];
    }

    /// @inheritdoc IOccultaVault
    function pendingRedeemRequest(address controller) external view override returns (euint256) {
        return _pendingRedeemShares[controller];
    }

    /// @inheritdoc IOccultaVault
    function claimableRedeemRequest(address controller) external view override returns (euint256) {
        return _claimableRedeemShares[controller];
    }

    /**
     * @notice Encrypted running sum of deposit assets pulled into the vault but not yet
     * converted to shares (pending + claimable across every controller).
     * @dev ACL: only the vault itself and the agent (`owner()`) can decrypt this handle.
     * Individual controllers only see their own bucket via {pendingDepositRequest}.
     */
    function totalPendingDepositAssets() external view returns (euint256) {
        return _totalPendingDepositAssets;
    }

    /// @inheritdoc IOccultaVault
    function isAllowedFor(euint256 handle, address who) external view override returns (bool) {
        return Nox.isAllowed(handle, who);
    }

    // ============ Agent viewership (totalSupply / totalAssets) ============
    // Every op that mutates the vault's encrypted totals produces a new handle that only the
    // vault itself is allowed on by default. These re-grant persistent Nox ACL to the Ownable
    // `owner()` after each mutation, so the agent can decrypt totals off-chain. Depositors keep
    // seeing only their own handles.

    /// @dev Re-grants the agent persistent Nox ACL on the new `totalSupply` handle after every
    ///      mint/burn/transfer of shares.
    function _update(address from, address to, euint256 amount)
        internal
        override
        returns (euint256 transferred)
    {
        transferred = super._update(from, to, amount);
        Nox.allow(confidentialTotalSupply(), owner());
    }

    /**
     * @dev Pulls `amount` of the underlying asset from `from` into the vault. Requires `from` to
     * have called `asset.setOperator(vault, until)` and granted this vault Nox ACL access to the
     * handle backing `amount`. Returns the encrypted amount actually transferred (may be less
     * than `amount` under confidential clamp).
     */
    function _transferIn(address from, euint256 amount) internal returns (euint256 transferred) {
        Nox.allowTransient(amount, address(_asset));
        transferred = _asset.confidentialTransferFrom(from, address(this), amount);
        Nox.allowThis(transferred);
        Nox.allow(confidentialTotalAssets(), owner());
    }

    /**
     * @dev Sends `amount` of the underlying asset from the vault to `to`. Returns the encrypted
     * amount actually sent (may be less than `amount` under confidential clamp).
     *
     * Routed through `confidentialTransferFrom(address(this), to, amount)` rather than the
     * plain `confidentialTransfer(to, amount)`: only the "From" variant grants its caller
     * transient Nox ACL access to the returned handle (`Nox.allowTransient(transferred,
     * msg.sender)`), which this function needs to re-grant `sent` to `to` below. `isOperator`
     * is satisfied trivially since holder and spender are both this vault.
     */
    function _transferOut(address to, euint256 amount) internal returns (euint256 sent) {
        Nox.allowThis(amount);
        Nox.allowTransient(amount, address(_asset));
        sent = _asset.confidentialTransferFrom(address(this), to, amount);
        Nox.allow(sent, to);
        Nox.allow(confidentialTotalAssets(), owner());
    }

    /**
     * @dev Converts assets to shares using OZ's virtual-shares/virtual-assets formula:
     * `shares = assets * (totalSupply + 10^offset) / (totalAssets + 1)`. Rounding is always
     * floor (no Ceil primitive exists in Nox today).
     */
    function _convertToShares(euint256 assets, euint256 totalAssetsBefore, euint256 totalSupplyBefore)
        internal
        returns (euint256 shares)
    {
        euint256 numerator = Nox.mul(assets, Nox.add(totalSupplyBefore, Nox.toEuint256(10 ** _decimalsOffset())));
        euint256 denominator = Nox.add(totalAssetsBefore, Nox.toEuint256(1));
        shares = Nox.div(numerator, denominator);
        Nox.allowThis(shares);
    }

    /**
     * @dev Converts shares to assets using the symmetric formula:
     * `assets = shares * (totalAssets + 1) / (totalSupply + 10^offset)`. Rounding is floor.
     */
    function _convertToAssets(euint256 shares, euint256 totalAssetsBefore, euint256 totalSupplyBefore)
        internal
        returns (euint256 assets)
    {
        euint256 numerator = Nox.mul(shares, Nox.add(totalAssetsBefore, Nox.toEuint256(1)));
        euint256 denominator = Nox.add(totalSupplyBefore, Nox.toEuint256(10 ** _decimalsOffset()));
        assets = Nox.div(numerator, denominator);
        Nox.allowThis(assets);
    }

    /// @dev Reads the pre-settlement NAV snapshot used by both approve entry points.
    function _snapshot() internal view returns (euint256 assetsBefore, euint256 supplyBefore) {
        assetsBefore = confidentialTotalAssets();
        supplyBefore = confidentialTotalSupply();
    }

    /**
     * @dev Virtual-share offset for inflation-attack defense in depth (OZ pattern). Pushed to 6
     * (the underlying asset's decimals) to make the attack orders of magnitude more expensive
     * than any realistic gain.
     */
    function _decimalsOffset() internal pure returns (uint8) {
        return 6;
    }
}
