import type { AgentContext } from "./context.js";
import { strategyRegistryAbi } from "./abi.js";
import { withGatewayRetry } from "./gatewayRetry.js";
import * as log from "./logger.js";

/**
 * The sealed policy, per `IStrategyRegistry.registerAgent`'s documented slot convention:
 *   0 = targetWeightBps      target allocation weight, in basis points
 *   1 = rebalanceTriggerBps  drift that triggers a rebalance, in basis points
 *   2 = maxLeverageBps       maximum leverage, in basis points
 *   3 = riskCapBps           maximum risk budget, in basis points
 *
 * This runtime never borrows against Aave collateral (see `strategy.ts`'s header), so
 * `maxLeverageBps` is read and asserted as a policy-conformance invariant, not used to size a
 * trade — a strategy that never borrows is always inside any sane leverage cap.
 */
export interface Policy {
  targetWeightBps: bigint;
  rebalanceTriggerBps: bigint;
  maxLeverageBps: bigint;
  riskCapBps: bigint;
}

const SLOT_NAMES = ["targetWeightBps", "rebalanceTriggerBps", "maxLeverageBps", "riskCapBps"] as const;

/**
 * Decrypts the four sealed policy slots off-chain via the live Nox gateway. Only the address
 * `StrategyRegistry.registerAgent` (or a later `setRuntime`) granted decrypt access to can do
 * this — this runtime's key must be that agent's registered runtime, which `context.ts` /
 * `settlement.ts`'s pre-flight checks confirm before any of this is trusted.
 */
export async function readPolicy(ctx: AgentContext): Promise<Policy> {
  const values: bigint[] = [];
  for (let idx = 0; idx < SLOT_NAMES.length; idx++) {
    const handle = await ctx.publicClient.readContract({
      address: ctx.addresses.strategyRegistry,
      abi: strategyRegistryAbi,
      functionName: "policyOf",
      args: [ctx.agentId, BigInt(idx)],
    });
    const { value } = await withGatewayRetry(`decrypt(policy[${idx}])`, () => ctx.handleClient.decrypt(handle));
    const bps = value as bigint;
    values.push(bps);
    log.info(`decrypted policy slot ${idx} (${SLOT_NAMES[idx]})`, { bps: bps.toString() });
  }

  return {
    targetWeightBps: values[0]!,
    rebalanceTriggerBps: values[1]!,
    maxLeverageBps: values[2]!,
    riskCapBps: values[3]!,
  };
}
