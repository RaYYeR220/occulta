// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {
    Nox,
    ebool,
    euint256,
    externalEbool,
    externalEuint256
} from "@iexec-nox/nox-protocol-contracts/contracts/sdk/Nox.sol";

import {INetSettler} from "../interfaces/INetSettler.sol";
import {IExecutionTarget} from "../interfaces/IExecutionTarget.sol";
import {IStrategyRegistry} from "../interfaces/IStrategyRegistry.sol";

/**
 * @title NetSettler
 * @notice Confidentiality by aggregation. Depositor trading intents enter encrypted — size AND
 * side — are summed inside the TEE, and leave as ONE plaintext number: the epoch's aggregate net
 * order. That single number is all the public protocols ever see, and all anyone else ever can.
 *
 * @dev The privacy argument, in full, since this contract is where the product's thesis lives or
 * dies.
 *
 * An epoch accumulates two encrypted running totals, `buyTotal` and `sellTotal`. Every intent is
 * folded into BOTH of them: under its encrypted side bit, `Nox.select` routes the intent's size
 * to one total and an encrypted zero to the other. No individual intent is ever compared, sorted,
 * revealed, or granted to anybody but this contract and the agent's runtime. {closeEpoch} then
 * computes
 *
 *     net = |buyTotal - sellTotal|,   netIsBuy = (buyTotal >= sellTotal)
 *
 * and marks EXACTLY those two handles publicly decryptable — never the intents, never their
 * sides, never the two running totals. Publishing `net` is safe precisely because it is a sum
 * over an unknown partition: 300 could be one depositor buying 300, or a hundred of them netting
 * to it. Nothing in the aggregate distinguishes those worlds. Publishing the two totals
 * separately would NOT be safe (an observer differencing consecutive epochs could isolate a
 * single intent), which is why they stay sealed even though the net derived from them does not.
 *
 * Why the side is encrypted too. A plaintext side is a real leak, not a theoretical one. The
 * `euint256` overload of {submitIntent} exists precisely to fold in handles that already live
 * on-chain, and some of those are public views keyed by address — `confidentialBalanceOf(alice)`
 * returns exactly such a handle. Emit a plaintext side next to a handle anyone can look up
 * against a named depositor, and that depositor's direction is public. Size sealed, side sold.
 * So the side arrives as an `ebool` and is never decrypted, never granted beyond this contract
 * and the runtime, and never made publicly decryptable.
 *
 * The fold is branchless and side-symmetric:
 *
 *     buyContribution  = select(isBuy, amount, 0)
 *     sellContribution = select(isBuy, 0, amount)
 *     buyTotal  += buyContribution
 *     sellTotal += sellContribution
 *
 * Both selects and both adds execute for EVERY intent, so a buy and a sell are indistinguishable
 * in the trace: same selector, same calldata length, same NoxCompute op sequence, same events.
 * (Gas differs only by the calldata zero-byte count of the random ciphertexts themselves, which
 * is independent of the side.) The sum is unchanged — an intent adds its size to its own side and
 * a hard zero to the other — so {closeEpoch} nets exactly as it did when the side was a plaintext
 * branch.
 *
 * Branchlessness. Nothing in the netting path branches on, or reverts because of, an encrypted
 * value. `Nox.safeSub` is computed in BOTH directions and `Nox.select` picks the right one under
 * the encrypted comparison; the losing branch's underflow flag is discarded unread. A `require`
 * on a ciphertext, or an `if` that skips work when sells happen to exceed buys, would publish
 * the comparison result through the transaction's success, gas, or trace — the classic side
 * channel this design exists to avoid. Every plaintext branch in this file (`closed`, `settled`,
 * `netPlaintext > 0`) reads a value that is already public in storage or was just proven public.
 *
 * The encrypted zero is not a secret and does not need to be: `Nox.toEuint256(0)` mints a PUBLIC
 * handle over a constant the whole world already knows. It carries no information about the
 * intent it is selected against, and it is the same handle for every intent on every side.
 *
 * Trust. {settle} does not accept a number. It accepts a PROOF, and hands it to
 * `Nox.publicDecrypt`, which recovers the decryption gateway's signature over
 * `(handle, plaintext)` inside NoxCompute. A caller who forges a plaintext, replays another
 * epoch's proof, or mutates the payload of a valid one, fails signature recovery and reverts.
 * The plaintext the executor receives is thus the TEE's, never the caller's — which is what makes
 * it safe for the agent runtime to be the only party that can call this contract at all.
 *
 * The residual limit, stated plainly. The number of intents in an epoch is structurally visible,
 * and a ONE-intent epoch reveals that depositor's order exactly, because the aggregate simply IS
 * their intent. Aggregation therefore protects a depositor only insofar as the runtime batches
 * several intents into an epoch. That batching is a property of the attested TEE runtime, not of
 * this contract, and no on-chain counter can substitute for it — see {INetSettler}.
 *
 * Scope. The settler stops at the verified plaintext net. Execution against real Aave V3 and
 * Uniswap V3 lives behind {IExecutionTarget} and is implemented in Tasks 7-8.
 */
contract NetSettler is INetSettler {
    // ============ Types ============

    /**
     * @dev One netting round for one agent. `buyTotal` / `sellTotal` are left as the zero handle
     * until the first intent lands: `Nox.add` resolves an undefined handle to the typed public
     * zero, so an untouched total costs nothing and still nets correctly.
     */
    struct Epoch {
        euint256 buyTotal;
        euint256 sellTotal;
        /// @dev Aggregate net magnitude. Set — and made publicly decryptable — only at close.
        euint256 net;
        /// @dev Aggregate direction. Set — and made publicly decryptable — only at close.
        ebool netIsBuy;
        uint64 intentCount;
        bool closed;
        bool settled;
    }

    // ============ Storage ============

    /// @notice The registry that names each agent's authorized runtime.
    IStrategyRegistry public immutable registry;

    /**
     * @notice Where a proven aggregate net goes to be traded. May be the zero address, in which
     * case {settle} proves and emits the net but forwards it nowhere — the deployment shape used
     * until the Aave/Uniswap adapters are wired in (Task 10).
     */
    IExecutionTarget public immutable executor;

    mapping(uint256 agentId => uint256) private _currentEpoch;
    mapping(uint256 agentId => mapping(uint256 epoch => Epoch)) private _epochs;

    // ============ Errors ============

    /// @notice Thrown when the caller is not the runtime registered for `agentId`.
    error NetSettlerNotAgentRuntime(uint256 agentId, address caller);

    /// @notice Thrown when `agentId` is registered but no longer active.
    error NetSettlerAgentInactive(uint256 agentId);

    /// @notice Thrown when the caller holds no Nox grant on the intent handle it submitted.
    error NetSettlerUnauthorizedIntent(euint256 amount, address caller);

    /// @notice Thrown when closing an epoch that no intent was ever filed against.
    error NetSettlerEmptyEpoch(uint256 agentId, uint256 epoch);

    /// @notice Thrown when writing an intent into an epoch that has already been netted.
    error NetSettlerEpochAlreadyClosed(uint256 agentId, uint256 epoch);

    /// @notice Thrown when settling an epoch that was never closed, so has no proven net.
    error NetSettlerEpochNotClosed(uint256 agentId, uint256 epoch);

    /// @notice Thrown when settling an epoch a second time.
    error NetSettlerEpochAlreadySettled(uint256 agentId, uint256 epoch);

    /// @notice Thrown when the settler is deployed against the zero-address registry.
    error NetSettlerZeroRegistry();

    // ============ Modifiers ============

    /**
     * @dev Restricts a call to the runtime the strategist named for `agentId`, and only while
     * that agent is active. The registry is the single source of truth for both, and it reverts
     * with `UnknownAgent` for an agentId that was never registered — so an unknown agent has no
     * authorized caller at all.
     *
     * The `active` check is what makes a future deactivation mean something: revoking an agent
     * must revoke its runtime's right to submit into, close, and settle epochs, not merely stop
     * new registrations. Reading the flag here is the only place that can enforce it.
     */
    modifier onlyAgentRuntime(uint256 agentId) {
        IStrategyRegistry.AgentMeta memory meta = registry.metaOf(agentId);
        require(msg.sender == meta.runtime, NetSettlerNotAgentRuntime(agentId, msg.sender));
        require(meta.active, NetSettlerAgentInactive(agentId));
        _;
    }

    // ============ Constructor ============

    /**
     * @param registry_ Registry naming each agent's authorized runtime.
     * @param executor_ Execution target for proven aggregate nets. May be `address(0)`: the
     * settler is then a pure netting engine, and {settle} simply emits the proven order.
     */
    constructor(IStrategyRegistry registry_, IExecutionTarget executor_) {
        require(address(registry_) != address(0), NetSettlerZeroRegistry());
        registry = registry_;
        executor = executor_;
    }

    // ============ Intent submission ============

    /// @inheritdoc INetSettler
    function submitIntent(
        uint256 agentId,
        euint256 amount,
        externalEbool encIsBuy,
        bytes calldata sideProof
    ) external override onlyAgentRuntime(agentId) {
        // The runtime may only fold in ciphertexts it is itself entitled to — it cannot conscript
        // a third party's handle (a stranger's balance, another agent's net) into this epoch.
        require(
            Nox.isAllowed(amount, msg.sender),
            NetSettlerUnauthorizedIntent(amount, msg.sender)
        );
        _accumulate(agentId, amount, Nox.fromExternal(encIsBuy, sideProof));
    }

    /// @inheritdoc INetSettler
    function submitIntent(
        uint256 agentId,
        externalEuint256 encAmount,
        bytes calldata amountProof,
        externalEbool encIsBuy,
        bytes calldata sideProof
    ) external override onlyAgentRuntime(agentId) {
        // `fromExternal` validates each encryption proof against NoxCompute and binds the handle
        // to this contract, so a secret enters the epoch the only way a secret may. The side is a
        // secret exactly like the size, and travels the same road.
        _accumulate(
            agentId,
            Nox.fromExternal(encAmount, amountProof),
            Nox.fromExternal(encIsBuy, sideProof)
        );
    }

    /**
     * @dev Folds one encrypted intent into the open epoch. Both totals move on every intent; the
     * encrypted side decides which one moves by the intent's size and which one moves by zero.
     *
     * Nothing here reads the side. There is no `if`, no `require`, and no early return keyed on
     * it: the two `select`s and the two `add`s run unconditionally, in the same order, for every
     * intent. Two submissions of equal size and opposite side are therefore identical in calldata
     * shape, in NoxCompute op sequence, and in the event they emit — the only difference is inside
     * ciphertext nobody but the TEE can open.
     *
     * ACL. The intent's size and its side are granted to this contract (so the totals they feed
     * remain usable in later transactions) and to the runtime (so the agent can audit its own
     * submissions off-chain). They are granted to nobody else. `allowPublicDecryption` is never
     * called on either — not here, not anywhere in this file except on the aggregate net and its
     * direction in {closeEpoch}. The per-intent contributions produced by the two `select`s are
     * transient: they are consumed by the two `add`s in this same transaction and never stored,
     * emitted, or granted at all.
     */
    function _accumulate(uint256 agentId, euint256 amount, ebool isBuy) private {
        uint256 epoch = _currentEpoch[agentId];
        Epoch storage e = _epochs[agentId][epoch];
        // Defensive: `closeEpoch` advances `_currentEpoch`, so the epoch an intent lands in is
        // open by construction. Kept so the invariant is enforced, not merely relied upon.
        require(!e.closed, NetSettlerEpochAlreadyClosed(agentId, epoch));

        Nox.allowThis(amount);
        Nox.allow(amount, msg.sender);
        Nox.allowThis(isBuy);
        Nox.allow(isBuy, msg.sender);

        // A public handle over the constant 0 — not a secret, and nothing about the intent can be
        // read out of it. It is the neutral element the losing side is charged.
        euint256 zero = Nox.toEuint256(0);
        euint256 buyContribution = Nox.select(isBuy, amount, zero);
        euint256 sellContribution = Nox.select(isBuy, zero, amount);

        euint256 newBuyTotal = Nox.add(e.buyTotal, buyContribution);
        euint256 newSellTotal = Nox.add(e.sellTotal, sellContribution);

        e.buyTotal = newBuyTotal;
        e.sellTotal = newSellTotal;

        Nox.allowThis(newBuyTotal);
        Nox.allow(newBuyTotal, msg.sender);
        Nox.allowThis(newSellTotal);
        Nox.allow(newSellTotal, msg.sender);

        e.intentCount += 1;

        emit IntentSubmitted(agentId, epoch, msg.sender);
    }

    // ============ Netting and reveal ============

    /**
     * @inheritdoc INetSettler
     * @dev The selective reveal, in six lines — and unchanged by the sealing of the side, because
     * the arithmetic it consumes is unchanged. An intent of size `a` on the buy side contributes
     * `(a, 0)` to `(buyTotal, sellTotal)` and one on the sell side contributes `(0, a)`, exactly
     * as when the side was a plaintext branch that touched one accumulator. The difference
     * `buyTotal - sellTotal` is the same number it always was.
     *
     * `buyWins`, `netIfBuy` and `netIfSell` are all computed unconditionally; `Nox.select` then
     * folds the encrypted comparison into a single result without the EVM ever learning which
     * way it went. The `safeSub` on the losing side underflows and its success flag is discarded
     * — deliberately. Reading it would mean branching on a ciphertext, and the value behind it is
     * never selected.
     *
     * Only `net` and `buyWins` are marked publicly decryptable. `buyTotal` and `sellTotal` — the
     * operands they were derived from — keep their ordinary ACL and stay sealed forever, as does
     * every intent, and every intent's side, that fed them.
     *
     * An empty epoch cannot be closed: a net of zero over an empty intent set is a public
     * statement that the agent had no flow, which is information the agent's competitors would
     * happily take for free. Reverting on it costs nothing and is a plaintext check on a
     * plaintext counter.
     */
    function closeEpoch(
        uint256 agentId
    ) external override onlyAgentRuntime(agentId) returns (euint256 netHandle, ebool netIsBuy) {
        uint256 epoch = _currentEpoch[agentId];
        Epoch storage e = _epochs[agentId][epoch];
        require(e.intentCount > 0, NetSettlerEmptyEpoch(agentId, epoch));

        ebool buyWins = Nox.ge(e.buyTotal, e.sellTotal);
        (, euint256 netIfBuy) = Nox.safeSub(e.buyTotal, e.sellTotal);
        (, euint256 netIfSell) = Nox.safeSub(e.sellTotal, e.buyTotal);
        euint256 net = Nox.select(buyWins, netIfBuy, netIfSell);

        // Persist the ACL on both aggregates: compute grants only transient access, so without
        // this the handles are dead in the next transaction — including in `settle`.
        Nox.allowThis(net);
        Nox.allowThis(buyWins);

        // The reveal. The only two `allowPublicDecryption` calls in the contract — which is also
        // the grant the runtime decrypts them under, so no separate grant to `msg.sender` is
        // needed here.
        Nox.allowPublicDecryption(net);
        Nox.allowPublicDecryption(buyWins);

        e.net = net;
        e.netIsBuy = buyWins;
        e.closed = true;
        _currentEpoch[agentId] = epoch + 1;

        emit EpochClosed(agentId, epoch, net, buyWins);
        return (net, buyWins);
    }

    /**
     * @inheritdoc INetSettler
     * @dev The single most important check in the contract is the pair of `Nox.publicDecrypt`
     * calls: they are the ONLY way a plaintext enters this contract. Each one re-derives the
     * EIP-712 digest over `(storedHandle, decryptedPayload)` inside NoxCompute and requires the
     * decryption gateway's signature over it. Consequently:
     *   - a proof minted for another epoch's (or another agent's) handle recovers to the wrong
     *     signer against THIS epoch's stored handle, and reverts;
     *   - a proof whose plaintext payload was edited recovers to the wrong signer, and reverts;
     *   - garbage reverts.
     * There is no code path in which the caller's claim about the net is believed.
     *
     * A zero net is proven and emitted like any other, but not forwarded: there is no order to
     * place, and `netIsBuy` is meaningless on a zero net (`ge` is true on equality, so it reports
     * a buy). The magnitude is already public at that point, so the branch discloses nothing.
     * {IExecutionTarget} may therefore assume a non-zero `netAmount`.
     */
    function settle(
        uint256 agentId,
        uint256 epoch,
        bytes calldata decryptionProof,
        bytes calldata directionProof,
        uint256 minOut
    ) external override onlyAgentRuntime(agentId) {
        Epoch storage e = _epochs[agentId][epoch];
        require(e.closed, NetSettlerEpochNotClosed(agentId, epoch));
        require(!e.settled, NetSettlerEpochAlreadySettled(agentId, epoch));

        uint256 netPlaintext = Nox.publicDecrypt(e.net, decryptionProof);
        bool netIsBuy = Nox.publicDecrypt(e.netIsBuy, directionProof);

        e.settled = true;

        emit Settled(agentId, epoch, netPlaintext, netIsBuy);

        if (netPlaintext > 0 && address(executor) != address(0)) {
            executor.executeNet(agentId, epoch, netPlaintext, netIsBuy, minOut);
        }
    }

    // ============ Views ============

    /// @inheritdoc INetSettler
    function currentEpoch(uint256 agentId) external view override returns (uint256) {
        return _currentEpoch[agentId];
    }

    /// @inheritdoc INetSettler
    function netOf(uint256 agentId, uint256 epoch) external view override returns (euint256) {
        return _epochs[agentId][epoch].net;
    }

    /// @inheritdoc INetSettler
    function netDirectionOf(
        uint256 agentId,
        uint256 epoch
    ) external view override returns (ebool) {
        return _epochs[agentId][epoch].netIsBuy;
    }

    /// @inheritdoc INetSettler
    function epochStateOf(
        uint256 agentId,
        uint256 epoch
    ) external view override returns (uint256 intentCount, bool closed, bool settled) {
        Epoch storage e = _epochs[agentId][epoch];
        return (e.intentCount, e.closed, e.settled);
    }

    /**
     * @notice Handle of the epoch's running buy total.
     * @dev Returned as an opaque handle, exactly like the vault exposes its encrypted totals.
     * ACL: this contract and the agent's runtime, and no one else. It is NEVER made publicly
     * decryptable — only the net derived from it is. Exposed so that claim is checkable by
     * anyone, against {isPubliclyDecryptable}, rather than merely asserted in a comment.
     */
    function buyTotalOf(uint256 agentId, uint256 epoch) external view returns (euint256) {
        return _epochs[agentId][epoch].buyTotal;
    }

    /**
     * @notice Handle of the epoch's running sell total.
     * @dev Same disclosure rules as {buyTotalOf}: sealed to this contract and the runtime,
     * never publicly decryptable.
     */
    function sellTotalOf(uint256 agentId, uint256 epoch) external view returns (euint256) {
        return _epochs[agentId][epoch].sellTotal;
    }

    /// @inheritdoc INetSettler
    function isAllowedFor(euint256 handle, address who) external view override returns (bool) {
        return Nox.isAllowed(handle, who);
    }

    /// @inheritdoc INetSettler
    function isPubliclyDecryptable(euint256 handle) external view override returns (bool) {
        return Nox.isPubliclyDecryptable(handle);
    }
}
