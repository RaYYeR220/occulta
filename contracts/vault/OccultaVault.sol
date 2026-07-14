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
 * Productive NAV = `confidentialTotalAssets() - _totalPendingDepositAssets -
 * _totalClaimableRedeemAssets`: the vault's balance minus every asset in it that backs no
 * outstanding share. Excluding pending deposits keeps concurrent deposit requests from diluting
 * one another and avoids the `assets / (assets + 1) = 0` degeneracy on the very first deposit;
 * excluding approved-but-unclaimed redeems (whose shares are already burned, but whose assets
 * only leave at claim time) keeps a settlement batch from pricing the same capital twice.
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
     */
    euint256 private _totalPendingDepositAssets;

    /**
     * @dev Running sum of assets reserved for approved-but-unclaimed redeems across every
     * controller (the global mirror of `_claimableRedeemAssets`). `approveRedeem` burns the
     * escrowed shares immediately, but the matching assets keep sitting in the vault's balance
     * until the controller calls {redeem}. During that window they are already spoken for: they
     * back no outstanding shares and must not be priced into anybody else's settlement.
     * Incremented at `approveRedeem`, decremented by whatever {redeem} actually sends out.
     */
    euint256 private _totalClaimableRedeemAssets;

    // ============ Errors ============

    error OccultaVaultInvalidAsset(address providedAsset);
    error OccultaVaultZeroAddress();
    /// @dev Thrown by every sync ERC-4626 entry point: this vault is async-only.
    error OccultaVaultSyncEntryPointDisabled();
    /// @dev Thrown when a request names the vault itself as the funds owner — see {_requestDeposit}.
    error OccultaVaultSelfRequest();
    /// @dev Thrown by {renounceOwnership}: renouncing would permanently strand deposited value.
    error RenounceDisabled();

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

        // Seed the inflight counters so the first request/settlement can add to a known handle.
        euint256 zero = Nox.toEuint256(0);
        _totalPendingDepositAssets = zero;
        _totalClaimableRedeemAssets = zero;
        Nox.allowThis(zero);
        Nox.allow(zero, initialOwner_);
    }

    // ============ Ownership ============

    /**
     * @notice Renouncing ownership is permanently disabled on this vault.
     * @dev `approveDeposit` / `approveRedeem` are the ONLY path from a pending request to a
     * claimable one and are `onlyOwner`, and there is no on-chain path that lets the agent's
     * authority pass to `address(0)` safely. A renounce would set the owner to `address(0)` and
     * lock 100% of every depositor's pending value forever. `transferOwnership` is deliberately
     * left intact (the agent runtime key can still be rotated).
     */
    function renounceOwnership() public pure override {
        revert RenounceDisabled();
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
        // ERC-7984's `_updateWithOptimizedPrimitives` short-circuits a self-transfer and returns
        // `amount` unclamped, so a `from == to == address(this)` request would credit a bucket
        // with an arbitrary amount while moving no tokens. Unreachable today only by accident
        // (the vault never calls itself), so nail it shut explicitly.
        require(owner_ != address(this), OccultaVaultSelfRequest());
        require(isOperator(owner_, msg.sender), ERC7984UnauthorizedSpender(owner_, msg.sender));

        euint256 transferred = _transferIn(owner_, assets);
        // The emitted handle is worthless to an off-chain indexer without a persistent grant.
        Nox.allow(transferred, owner());
        Nox.allow(transferred, owner_);

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
        // Same self-transfer footgun as in {_requestDeposit}: escrowing from the vault to the
        // vault would return `shares` unclamped and inflate the pending bucket for free.
        require(owner_ != address(this), OccultaVaultSelfRequest());
        require(isOperator(owner_, msg.sender), ERC7984UnauthorizedSpender(owner_, msg.sender));

        // Escrow the shares: move them from owner_ to this vault.
        Nox.allowThis(shares);
        euint256 transferred = _transfer(owner_, address(this), shares);
        Nox.allowThis(transferred);
        Nox.allow(transferred, owner());
        Nox.allow(transferred, owner_);

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
        Nox.allow(approved, owner());
        Nox.allow(approved, owner_);

        // Snapshot productive NAV BEFORE decrementing _totalPendingDepositAssets: at this point
        // it still contains the full pending of this controller, correctly excluded from the
        // productive denominator.
        (euint256 assetsBefore, euint256 supplyBefore) = _snapshot();
        euint256 productiveAssets = _productiveAssets(assetsBefore);
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
        Nox.allow(approved, owner());
        Nox.allow(approved, owner_);

        // Snapshot productive NAV. `_productiveAssets` excludes the assets already reserved for
        // earlier approved-but-unclaimed redeems, so settling a batch of redeems back-to-back
        // prices every leg against the shares that are actually still outstanding.
        (euint256 assetsBefore, euint256 supplyBefore) = _snapshot();
        euint256 productiveAssets = _productiveAssets(assetsBefore);
        euint256 assetsOut = _convertToAssets(approved, productiveAssets, supplyBefore);
        Nox.allowThis(assetsOut);

        // Burn the escrowed shares now.
        _burn(address(this), approved);

        // Earmark the assets: they stay in the vault's balance but stop being productive.
        euint256 newTotalClaimableRedeem = Nox.add(_totalClaimableRedeemAssets, assetsOut);
        _totalClaimableRedeemAssets = newTotalClaimableRedeem;
        Nox.allowThis(newTotalClaimableRedeem);
        Nox.allow(newTotalClaimableRedeem, owner());

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
     * `_transferOut` with no NAV calculation.
     *
     * Shortfall-safe, all-or-nothing: `_transferOut` routes through ERC-7984's optimized
     * primitive, which is all-or-nothing — on a short vault balance `transferred == 0` and
     * balances are left untouched (never a partial clamp). So `sent` is either the full claim or
     * zero, and the asset bucket is set to the RESIDUAL (`assets - sent`): either zeroed (full
     * success) or left holding the ENTIRE claim (shortfall), re-claimable in full later — never
     * silently destroyed. `_totalClaimableRedeemAssets` is decremented by `sent` alone, so a
     * shortfall leaves the earmark intact. The share bucket — a settled-amount receipt, never
     * re-spent — is closed out in full.
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
        Nox.allowThis(zero);

        Nox.allowThis(assets);
        euint256 sent = _transferOut(receiver, assets);
        Nox.allowThis(sent);
        Nox.allow(sent, owner());

        euint256 residual = Nox.sub(assets, sent);
        _claimableRedeemAssets[controller] = residual;
        Nox.allowThis(residual);
        Nox.allow(residual, owner());
        Nox.allow(residual, controller);

        // Only what actually left the vault stops being reserved; the residual stays earmarked.
        euint256 newTotalClaimableRedeem = Nox.sub(_totalClaimableRedeemAssets, sent);
        _totalClaimableRedeemAssets = newTotalClaimableRedeem;
        Nox.allowThis(newTotalClaimableRedeem);
        Nox.allow(newTotalClaimableRedeem, owner());

        emit RedeemClaimed(controller, receiver, sent);
    }

    // ============ Cancel Phase (EIP-7540 escape hatches) ============

    /**
     * @inheritdoc IOccultaVault
     * @dev Returns the controller's PENDING (un-approved) deposit to it and zeroes the pending
     * bucket, mirroring {requestDeposit} in reverse. The claimable bucket is deliberately never
     * read: an approved deposit already minted shares against its assets, so those assets stay
     * productive and are not clawable here.
     *
     * Branchless and shortfall-safe: {_transferOut} routes through ERC-7984's optimized
     * primitive, which is all-or-nothing (`sent == amount`, or `sent == 0` and balances
     * untouched). The pending assets are always resident in the vault's balance — nothing removes
     * them between {requestDeposit} and here except approval, which this path does not touch — so
     * `sent` equals the full pending amount. The global inflight counter is decremented by `sent`,
     * so it stays exactly equal to the sum of the surviving pending buckets. ZERO_HANDLE is
     * handled: an empty pending bucket transfers zero and decrements the counter by zero.
     */
    function cancelDeposit(address controller) external override {
        require(controller != address(0), OccultaVaultZeroAddress());
        require(
            isOperator(controller, msg.sender),
            ERC7984UnauthorizedSpender(controller, msg.sender)
        );

        euint256 pending = _pendingDepositAssets[controller];
        euint256 zero = Nox.toEuint256(0);
        _pendingDepositAssets[controller] = zero;
        Nox.allowThis(zero);

        Nox.allowThis(pending);
        euint256 sent = _transferOut(controller, pending);
        Nox.allowThis(sent);
        Nox.allow(sent, owner());

        // Only what actually left the vault stops being pending; keeps the counter == Σ pending.
        euint256 newTotalPending = Nox.sub(_totalPendingDepositAssets, sent);
        _totalPendingDepositAssets = newTotalPending;
        Nox.allowThis(newTotalPending);
        Nox.allow(newTotalPending, owner());

        emit DepositCancelled(controller, sent);
    }

    /**
     * @inheritdoc IOccultaVault
     * @dev Returns the controller's PENDING (un-approved) escrowed redeem shares from the vault
     * back to it and zeroes the pending redeem bucket, mirroring {requestRedeem} in reverse. The
     * shares were escrowed (moved to the vault) at request time and are burned only at
     * {approveRedeem}, so a pending redeem's shares are still resident on the vault's balance and
     * are returned in full. Neither the claimable redeem bucket nor {_totalClaimableRedeemAssets}
     * is touched — those exist only for already-approved redeems.
     */
    function cancelRedeem(address controller) external override {
        require(controller != address(0), OccultaVaultZeroAddress());
        require(
            isOperator(controller, msg.sender),
            ERC7984UnauthorizedSpender(controller, msg.sender)
        );

        euint256 pendingShares = _pendingRedeemShares[controller];
        euint256 zero = Nox.toEuint256(0);
        _pendingRedeemShares[controller] = zero;
        Nox.allowThis(zero);

        Nox.allowThis(pendingShares);
        euint256 returned = _transfer(address(this), controller, pendingShares);
        Nox.allowThis(returned);
        Nox.allow(returned, owner());
        Nox.allow(returned, controller);

        emit RedeemCancelled(controller, returned);
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
     * @notice Encrypted amount of the underlying asset reserved for `controller` at
     * {approveRedeem} time and still sitting in the vault's balance, awaiting a {redeem} claim.
     * @dev The asset-denominated twin of {claimableRedeemRequest} (which reports the shares that
     * were burned to produce it). ACL: the vault, the agent (`owner()`) and `controller`.
     */
    function claimableRedeemAssets(address controller) external view returns (euint256) {
        return _claimableRedeemAssets[controller];
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

    /**
     * @notice Encrypted running sum of assets reserved for approved-but-unclaimed redeems across
     * every controller. Still part of {confidentialTotalAssets}, but already owed out — excluded
     * from the productive NAV both settlement paths price against.
     * @dev ACL: only the vault itself and the agent (`owner()`) can decrypt this handle.
     */
    function totalClaimableRedeemAssets() external view returns (euint256) {
        return _totalClaimableRedeemAssets;
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
     * @dev The vault's balance minus everything in it that is not backing an outstanding share:
     *
     *   productive = totalAssets - _totalPendingDepositAssets - _totalClaimableRedeemAssets
     *
     * - Pending deposits sit in the balance but no shares have been minted against them yet.
     * - Approved-but-unclaimed redeems sit in the balance but their shares are already burned.
     *
     * `_claimableDepositAssets` is deliberately NOT subtracted: `approveDeposit` already minted
     * shares against those assets, so they are productive from that moment and must keep backing
     * the shares they created.
     *
     * This is the only denominator either settlement path may price against — using the raw
     * `totalAssets` would count the same capital twice, over-paying whoever redeems next and
     * under-issuing shares to whoever deposits next.
     */
    function _productiveAssets(euint256 totalAssetsBefore) internal returns (euint256 productive) {
        productive = Nox.sub(
            Nox.sub(totalAssetsBefore, _totalPendingDepositAssets),
            _totalClaimableRedeemAssets
        );
        Nox.allowThis(productive);
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
