/**
 * The epoch the reveal card (and the netting section's live caption) features.
 *
 * `NetSettler` settles epochs independently and autonomously — a later epoch can close with a
 * different net entirely, in a different asset (a SELL nets in WETH, not USDC; see
 * `contracts/settle/NetSettler.sol` and `contracts/execution/OccultaExecutor.sol`). The rest of
 * this page — the netting diagram's buy 20 / buy 15 / sell 5, the proof section, the MCP scene —
 * is built around one specific settled epoch, so the reveal pins to that epoch by number rather
 * than always chasing "whatever settled most recently." It is still a real on-chain epoch and a
 * real live `publicDecrypt` of its handles — this only chooses which settled epoch to feature.
 *
 * Defaults to epoch 0, the documented demo run. Override with `NEXT_PUBLIC_FEATURED_EPOCH` if a
 * future deployment ever re-homes the demo to a different epoch number.
 */
export const FEATURED_EPOCH: bigint = (() => {
  const raw = process.env.NEXT_PUBLIC_FEATURED_EPOCH?.trim();
  if (!raw) return 0n;
  try {
    const parsed = BigInt(raw);
    return parsed >= 0n ? parsed : 0n;
  } catch {
    return 0n;
  }
})();
