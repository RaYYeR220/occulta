// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {
    ebool,
    euint256,
    externalEbool,
    externalEuint256
} from "@iexec-nox/nox-protocol-contracts/contracts/sdk/Nox.sol";

/**
 * @title INetSettler
 * @notice Confidential intent netting with selective reveal: many encrypted depositor intents
 * go in, exactly one plaintext aggregate order comes out.
 *
 * @dev THE DISCLOSURE CONTRACT — this is the product's core privacy claim, stated precisely.
 *
 * Revealed, per epoch, exactly once:
 *  - `netMagnitude`: |buyTotal - sellTotal|, the aggregate net order size.
 *  - `netDirection`: whether that aggregate is a buy or a sell.
 * Both are opened together at {closeEpoch} and are proof-verified on-chain at {settle}. They are
 * revealed because the public protocols (Aave V3, Uniswap V3) see exactly this much the instant
 * the swap lands: an order of that size, in that direction. Publishing it changes nothing an
 * observer could not already read off the pool.
 *
 * Never revealed, ever, to anyone:
 *  - Every individual intent amount. No `allowPublicDecryption` is called on an intent handle,
 *    and no ACL grant on one is issued beyond the settler itself and the agent runtime.
 *  - Every individual intent SIDE. The side is an `ebool`, not a `bool`: it never appears in
 *    calldata, in an event, or in storage as a plaintext, and it is folded into the totals
 *    branchlessly under `Nox.select` (see {NetSettler-_accumulate}). A plaintext side would be
 *    attributable, not merely abstract: an intent handle can be a pre-existing on-chain
 *    ciphertext — `IERC7984.confidentialBalanceOf(alice)` is a public view returning exactly such
 *    a handle — so a plaintext side published next to it would name a depositor's direction.
 *  - `buyTotal` and `sellTotal`. They are components of the aggregate, not the aggregate: if
 *    both were public, an observer could watch a single depositor's intent land between two
 *    epochs and difference them out. Only their netted difference is opened.
 *
 * Structurally visible (and accepted): the NUMBER of intents in an epoch. Nothing about their
 * sizes or their sides follows from the count — but the count is not nothing, and the honest
 * statement of the limit is this:
 *
 *   A one-intent epoch reveals that depositor's order exactly (the aggregate IS their intent).
 *   The aggregation guarantee is therefore CONDITIONAL on the attested runtime batching multiple
 *   intents per epoch — it is not enforced on-chain.
 *
 * There is deliberately no `minIntentsPerEpoch` floor, because such a floor would be theatre. The
 * runtime already holds an ACL grant on every intent it submits (it knows every plaintext) and it
 * alone chooses which intents enter an epoch; it could satisfy any floor N by padding with N-1
 * dummy intents of a size it picked, then subtracting them back out of the revealed aggregate.
 * The counter would be satisfied and the depositor would be just as exposed. What actually
 * defends a depositor against a malicious runtime is TEE attestation of the runtime binary — the
 * guarantee that the code choosing the batch is the code that was audited. This interface
 * documents that limit rather than pretending a counter closes it.
 *
 * The one-bit direction question. `netDirection` is genuinely secret information right up until
 * the trade prints, so opening it is a real decision, not a technicality. It is opened for two
 * reasons: (1) the execution path cannot act on a ciphertext — a swap needs a plaintext side —
 * and (2) it is inseparable from the net anyway, since the aggregate order is *defined* as a
 * (size, side) pair and the pool learns the side on execution. What matters is that it is the
 * side of the AGGREGATE. Nothing about which depositor pushed it that way, or by how much,
 * follows from it.
 *
 * A note on typing: `netDirection` is an `ebool` on-chain, not a `bool`. It cannot be a plaintext
 * `bool` at {closeEpoch} time — decryption in Nox is asynchronous and proof-gated, so no
 * comparison over ciphertext can produce a plaintext bit inside the closing transaction. It
 * becomes a plaintext `bool` at exactly the moment the magnitude does: in {settle}, from a
 * gateway-signed decryption proof verified on-chain. Direction and magnitude are therefore
 * revealed together, atomically, or not at all.
 */
interface INetSettler {
    // ============ Events ============

    /**
     * @notice A depositor's encrypted intent was folded into the open epoch.
     * @dev `amount` and `isBuy` are HANDLES, not values. They are emitted so the runtime — the
     * only party besides this contract holding an ACL grant on them — can audit that the intent
     * was counted; neither this event nor any other path makes them decryptable by anyone else.
     * A runtime-minted intent is not decryptable by the depositor it was minted for: the settler
     * grants no ACL to depositors.
     *
     * The event's shape does not depend on the side. A buy and a sell emit the same fields, the
     * same handle types, and the same number of logs — the side lives inside the `ebool` and
     * nowhere else.
     * @param agentId The strategy agent the intent was filed against.
     * @param epoch The epoch the intent landed in (always the agent's open epoch).
     * @param controller The account that submitted the intent — always the agent's runtime,
     * which is the only party authorized to route depositor intents into an epoch.
     * @param amount Encrypted intent size. Never revealed.
     * @param isBuy Encrypted intent side. Never revealed.
     */
    event IntentSubmitted(
        uint256 indexed agentId,
        uint256 indexed epoch,
        address indexed controller,
        euint256 amount,
        ebool isBuy
    );

    /**
     * @notice An epoch was netted and its aggregate marked publicly decryptable.
     * @dev `net` and `netIsBuy` are the ONLY two handles in the system that are ever made
     * publicly decryptable. Both are emitted as handles here; their plaintexts land in {Settled}.
     * @param agentId The strategy agent whose epoch closed.
     * @param epoch The epoch that closed.
     * @param net Handle of the aggregate net magnitude, now publicly decryptable.
     * @param netIsBuy Handle of the aggregate direction, now publicly decryptable.
     */
    event EpochClosed(
        uint256 indexed agentId,
        uint256 indexed epoch,
        euint256 net,
        ebool netIsBuy
    );

    /**
     * @notice An epoch's aggregate order was proved on-chain and released to execution.
     * @param agentId The strategy agent whose epoch settled.
     * @param epoch The epoch that settled.
     * @param netPlaintext The aggregate net magnitude, verified against NoxCompute — not a
     * number the caller asserted.
     * @param netIsBuy The aggregate direction, verified the same way.
     */
    event Settled(
        uint256 indexed agentId,
        uint256 indexed epoch,
        uint256 netPlaintext,
        bool netIsBuy
    );

    // ============ Intent submission ============

    /**
     * @notice Folds an already-on-chain encrypted intent into the agent's open epoch.
     * @dev For handles the runtime already holds a Nox grant on — a depositor's vault position,
     * say. The caller must be allowed on `amount`, and this settler must have been granted access
     * to it too (the runtime does so via `NoxCompute.allow`), otherwise the accumulation cannot
     * consume the ciphertext.
     *
     * The side is NOT taken as a plaintext here, and this overload is exactly why: the handle
     * being folded in may be one an observer can look up against a named address, so a plaintext
     * side would attribute a direction to that depositor. It is supplied as a freshly encrypted
     * `externalEbool` instead.
     * @param agentId The strategy agent to file the intent against.
     * @param amount Encrypted intent size — a handle the caller already holds a grant on.
     * @param encIsBuy Externally-encrypted intent side: `true` = buy, `false` = sell.
     * @param sideProof Encryption proof for `encIsBuy`, bound to this settler and to the caller.
     */
    function submitIntent(
        uint256 agentId,
        euint256 amount,
        externalEbool encIsBuy,
        bytes calldata sideProof
    ) external;

    /**
     * @notice Folds a freshly-encrypted intent into the agent's open epoch.
     * @dev Size and side are both secrets and both arrive the same way: as an external ciphertext
     * with an encryption proof that NoxCompute validates against this settler and this caller.
     * @param agentId The strategy agent to file the intent against.
     * @param encAmount Externally-encrypted intent size.
     * @param amountProof Encryption proof for `encAmount`, bound to this settler and to the
     * caller.
     * @param encIsBuy Externally-encrypted intent side: `true` = buy, `false` = sell.
     * @param sideProof Encryption proof for `encIsBuy`, bound to this settler and to the caller.
     */
    function submitIntent(
        uint256 agentId,
        externalEuint256 encAmount,
        bytes calldata amountProof,
        externalEbool encIsBuy,
        bytes calldata sideProof
    ) external;

    // ============ Netting and reveal ============

    /**
     * @notice Nets the open epoch, reveals ONLY the aggregate order, and opens the next epoch.
     * @dev The netting is branchless — no `require` and no `if` reads an encrypted value, because
     * a revert or a taken branch is itself an observable bit. See {NetSettler-closeEpoch}.
     * @param agentId The strategy agent whose epoch to close.
     * @return netHandle Aggregate net magnitude, now publicly decryptable.
     * @return netIsBuy Aggregate direction, now publicly decryptable. An `ebool`: it becomes a
     * plaintext bool only in {settle}, against a verified proof.
     */
    function closeEpoch(uint256 agentId) external returns (euint256 netHandle, ebool netIsBuy);

    /**
     * @notice Proves a closed epoch's aggregate order on-chain and releases it to execution.
     * @dev Both proofs are validated against NoxCompute, which recovers the decryption gateway's
     * signature over `(handle, plaintext)`. A proof for a different handle, or a proof whose
     * plaintext payload was altered, fails signature recovery and reverts. The contract therefore
     * never learns a number from its caller — it only ever learns one from the gateway.
     *
     * An epoch whose net proves to zero is marked settled and emitted, but is never forwarded to
     * the execution target: there is no order to place.
     * @param agentId The strategy agent whose epoch to settle.
     * @param epoch The closed epoch to settle.
     * @param decryptionProof Public-decryption proof for the epoch's net magnitude handle.
     * @param directionProof Public-decryption proof for the epoch's net direction handle.
     * @param minOut Slippage bound forwarded to the execution target.
     */
    function settle(
        uint256 agentId,
        uint256 epoch,
        bytes calldata decryptionProof,
        bytes calldata directionProof,
        uint256 minOut
    ) external;

    // ============ Views ============

    /// @notice The agent's currently open epoch — the one new intents land in.
    function currentEpoch(uint256 agentId) external view returns (uint256);

    /// @notice Handle of the aggregate net magnitude revealed for `epoch`. Zero handle if the
    /// epoch has not closed.
    function netOf(uint256 agentId, uint256 epoch) external view returns (euint256);

    /// @notice Handle of the aggregate direction revealed for `epoch`. Zero handle if the epoch
    /// has not closed.
    function netDirectionOf(uint256 agentId, uint256 epoch) external view returns (ebool);

    /// @notice Lifecycle state of `epoch`: how many intents it holds, and whether it has been
    /// closed and settled.
    function epochStateOf(
        uint256 agentId,
        uint256 epoch
    ) external view returns (uint256 intentCount, bool closed, bool settled);

    /// @notice Returns whether `who` may decrypt `handle` off-chain.
    /// @dev A Nox handle is a `bytes32` whatever its encrypted type, so this view answers for an
    /// intent's `ebool` side exactly as it does for its `euint256` size.
    function isAllowedFor(euint256 handle, address who) external view returns (bool);

    /// @notice Returns whether `handle` was marked publicly decryptable. Only an epoch's net
    /// magnitude and net direction ever are — never an intent's size, never an intent's side,
    /// never a running total.
    function isPubliclyDecryptable(euint256 handle) external view returns (bool);
}
