import type { AgentContext } from "./context.js";
import { approvePendingDeposits } from "./depositWatcher.js";
import { runSettlementCycle } from "./settlement.js";
import { classifyError } from "./errors.js";
import * as log from "./logger.js";

async function sleepInterruptible(ms: number, isCancelled: () => boolean): Promise<void> {
  const step = 250;
  let waited = 0;
  while (waited < ms && !isCancelled()) {
    const chunk = Math.min(step, ms - waited);
    await new Promise((resolve) => setTimeout(resolve, chunk));
    waited += chunk;
  }
}

/**
 * The watch loop. One tick =
 *   1. sweep pending deposits (best-effort, always attempted — cheap reads, and approving a
 *      deposit never depends on epoch cadence);
 *   2. if the epoch cadence has elapsed and no cycle is already in flight, run one settlement
 *      cycle (which itself decides, via live policy + market state, whether there is anything to
 *      rebalance at all).
 *
 * Confirmation-depth is enforced inside `depositWatcher.ts`'s log scan, not here. Backoff is
 * exponential on transient errors and resets to the configured poll interval on a clean tick or
 * a permanent error (see `errors.ts` for why a permanent error still gets a normal-cadence retry
 * rather than a tight loop). SIGINT/SIGTERM let the current tick finish, then stop cleanly.
 */
export async function startRuntime(ctx: AgentContext): Promise<void> {
  let shuttingDown = false;
  const requestShutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info(`received ${signal} — finishing the current tick, then stopping`);
  };
  process.on("SIGINT", () => requestShutdown("SIGINT"));
  process.on("SIGTERM", () => requestShutdown("SIGTERM"));

  log.info("occulta agent runtime starting", {
    dryRun: ctx.dryRun,
    runOnce: ctx.runOnce,
    agentId: ctx.agentId.toString(),
    runtime: ctx.walletClient.account!.address,
    pollIntervalMs: ctx.pollIntervalMs,
    epochCadenceMs: ctx.epochCadenceMs,
  });

  let backoffMs = ctx.pollIntervalMs;
  let lastCycleAt = 0;
  let cycleRunning = false;

  while (!shuttingDown) {
    try {
      await approvePendingDeposits(ctx);

      const now = Date.now();
      if (!cycleRunning && now - lastCycleAt >= ctx.epochCadenceMs) {
        cycleRunning = true;
        lastCycleAt = now;
        try {
          await runSettlementCycle(ctx);
        } finally {
          cycleRunning = false;
        }
      }

      backoffMs = ctx.pollIntervalMs;
    } catch (err) {
      const kind = classifyError(err);
      log.error(`tick failed (${kind})`, { error: err instanceof Error ? err.message : String(err) });
      backoffMs = kind === "transient" ? Math.min(backoffMs * 2, ctx.maxBackoffMs) : ctx.pollIntervalMs;
    }

    if (ctx.runOnce) {
      log.info("RUN_ONCE set — stopping after a single tick");
      break;
    }

    await sleepInterruptible(backoffMs, () => shuttingDown);
  }

  log.info("occulta agent runtime stopped");
}
