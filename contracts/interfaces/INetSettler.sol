// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {
    ebool,
    euint256,
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
 *  - `buyTotal` and `sellTotal`. They are components of the aggregate, not the aggregate: if
 *    both were public, an observer could watch a single depositor's intent land between two
 *    epochs and difference them out. Only their netted difference is opened.
 *
 * Structurally visible (and accepted): the number of intents in an epoch, and the plaintext
 * `isBuy` side of each one, which is an ordinary calldata argument selecting the accumulator to
 * fold into. A side without a size is not a position: it cannot be valued, sequenced against a
 * NAV, or netted back out of the aggregate.
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
     * @dev `amount` is a HANDLE, not a value. It is emitted so the runtime and the depositor can
     * audit that their intent was counted; neither this event nor any other path makes it
     * decryptable by anyone else.
     * @param agentId The strategy agent the intent was filed against.
     * @param epoch The epoch the intent landed in (always the agent's open epoch).
     * @param controller The account that submitted the intent — always the agent's runtime,
     * which is the only party authorized to route depositor intents into an epoch.
     * @param amount Encrypted intent size. Never revealed.
     * @param isBuy Side of this individual intent.
     */
    event IntentSubmitted(
        uint256 indexed agentId,
        uint256 indexed epoch,
        address indexed controller,
        euint256 amount,
        bool isBuy
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
     * @param agentId The strategy agent to file the intent against.
     * @param amount Encrypted intent size.
     * @param isBuy Side of this intent.
     */
    function submitIntent(uint256 agentId, euint256 amount, bool isBuy) external;

    /**
     * @notice Folds a freshly-encrypted intent into the agent's open epoch.
     * @param agentId The strategy agent to file the intent against.
     * @param encAmount Externally-encrypted intent size.
     * @param inputProof Encryption proof for `encAmount`, bound to this settler and to the caller.
     * @param isBuy Side of this intent.
     */
    function submitIntent(
        uint256 agentId,
        externalEuint256 encAmount,
        bytes calldata inputProof,
        bool isBuy
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
    function isAllowedFor(euint256 handle, address who) external view returns (bool);

    /// @notice Returns whether `handle` was marked publicly decryptable. Only an epoch's net
    /// magnitude and net direction ever are.
    function isPubliclyDecryptable(euint256 handle) external view returns (bool);
}
