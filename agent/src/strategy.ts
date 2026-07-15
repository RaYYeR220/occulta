import type { Policy } from "./policy.js";

/**
 * The strategy rule, in full — this is the entire trading logic this runtime executes, and it is
 * deliberately small: a target-allocation rebalance, nothing more.
 *
 * Inputs, all read live, none assumed:
 *   - `policy`: the strategist's sealed target weight, rebalance trigger, leverage cap, and risk
 *     cap, decrypted off-chain by `policy.ts` under the runtime's own Nox grant.
 *   - `capitalUsdc6`: the vault's confidential total assets (USDC, 6 decimals) — decrypted by
 *     `settlement.ts` since the vault's owner() is this runtime.
 *   - `currentDeployedUsd8`: `AaveAdapter.accountData().totalCollateralBase` — already plaintext
 *     on-chain (Aave's own oracle-base USD figure, 8 decimals), because the position it describes
 *     is real collateral a public protocol already prices.
 *   - `usdcPerOneWeth6`: a live Uniswap V3 QuoterV2 quote for 1 WETH -> USDC, used only to convert
 *     a dollar-denominated SELL size into the WETH units `OccultaExecutor` requires (see below).
 *
 * The rule: compare what fraction of the vault's capital is currently deployed as Aave
 * collateral against the strategist's sealed target fraction. If the drift exceeds the sealed
 * trigger, rebalance by the drift, capped by the sealed risk budget and by this runtime's own
 * configured safety ceilings (`maxIntentUsdc` / `maxIntentWeth` — a keeper-side circuit breaker,
 * independent of whatever the policy allows). No leverage, ever: the executor's BUY leg only
 * ever supplies WETH to Aave and the SELL leg only ever withdraws it — `OccultaExecutor` never
 * calls `AaveAdapter.borrow`, so `maxLeverageBps` is read and logged as an invariant check
 * elsewhere (`settlement.ts`), not consumed here.
 *
 * Unit convention, which this function must get right or the trade is wrong (see
 * `OccultaExecutor.sol`'s own header, which states this explicitly): a BUY's `netAmount` is USDC
 * — the capital to deploy. A SELL's `netAmount` is WETH — the collateral to withdraw. The two
 * legs are not denominated in the same asset, so a SELL decision's dollar-drift is converted to
 * WETH via the live quote before it is ever returned.
 */

export type RebalanceAction = "hold" | "buy" | "sell";

export interface RebalanceDecision {
  action: RebalanceAction;
  reason: string;
  /** 0 on hold; USDC (6-decimals) on buy; WETH (18-decimals) on sell. */
  intentAmount: bigint;
  driftBps: bigint;
  targetDeployedUsd8: bigint;
  currentDeployedUsd8: bigint;
  capitalUsdc6: bigint;
}

export interface DecisionInputs {
  policy: Policy;
  capitalUsdc6: bigint;
  currentDeployedUsd8: bigint;
  usdcPerOneWeth6: bigint;
  maxIntentUsdc: bigint;
  maxIntentWeth: bigint;
  minTradeUsdc: bigint;
  minTradeWeth: bigint;
}

const BPS_DENOMINATOR = 10_000n;
const USD8_PER_USDC6 = 100n; // 8-decimal USD base vs 6-decimal USDC: 10^(8-6)
const WETH_DECIMALS = 10n ** 18n;

export function computeDecision(inputs: DecisionInputs): RebalanceDecision {
  const {
    policy,
    capitalUsdc6,
    currentDeployedUsd8,
    usdcPerOneWeth6,
    maxIntentUsdc,
    maxIntentWeth,
    minTradeUsdc,
    minTradeWeth,
  } = inputs;

  const capitalUsd8 = capitalUsdc6 * USD8_PER_USDC6;
  const base = { driftBps: 0n, targetDeployedUsd8: 0n, currentDeployedUsd8, capitalUsdc6 };

  if (capitalUsd8 === 0n) {
    return { action: "hold", reason: "vault holds no confidential capital yet", intentAmount: 0n, ...base };
  }

  const targetDeployedUsd8 = (capitalUsd8 * policy.targetWeightBps) / BPS_DENOMINATOR;
  const driftUsd8 = currentDeployedUsd8 - targetDeployedUsd8; // >0: over-deployed; <0: under-deployed
  const driftAbsUsd8 = driftUsd8 < 0n ? -driftUsd8 : driftUsd8;
  const driftBps = (driftAbsUsd8 * BPS_DENOMINATOR) / capitalUsd8;

  const withDrift = { driftBps, targetDeployedUsd8, currentDeployedUsd8, capitalUsdc6 };

  if (driftBps < policy.rebalanceTriggerBps) {
    return {
      action: "hold",
      reason: `drift ${driftBps}bps is below the sealed rebalance trigger (${policy.rebalanceTriggerBps}bps)`,
      intentAmount: 0n,
      ...withDrift,
    };
  }

  const riskCapUsd8 = (capitalUsd8 * policy.riskCapBps) / BPS_DENOMINATOR;
  const cappedDriftUsd8 = driftAbsUsd8 < riskCapUsd8 ? driftAbsUsd8 : riskCapUsd8;
  const cappedDriftUsdc6 = cappedDriftUsd8 / USD8_PER_USDC6;

  if (driftUsd8 < 0n) {
    let amount = cappedDriftUsdc6;
    if (amount > maxIntentUsdc) amount = maxIntentUsdc;
    if (amount < minTradeUsdc) {
      return {
        action: "hold",
        reason: `computed buy size (${amount} USDC units) is below the dust floor (${minTradeUsdc})`,
        intentAmount: 0n,
        ...withDrift,
      };
    }
    return {
      action: "buy",
      reason:
        `deployed capital is ${driftBps}bps under target (trigger ${policy.rebalanceTriggerBps}bps) — ` +
        `deploying ${amount} USDC-units into WETH collateral, capped by risk budget and safety ceiling`,
      intentAmount: amount,
      ...withDrift,
    };
  }

  if (usdcPerOneWeth6 === 0n) {
    return {
      action: "hold",
      reason: "live WETH quote returned zero — refusing to size a sell leg off a broken price",
      intentAmount: 0n,
      ...withDrift,
    };
  }

  let amount = (cappedDriftUsdc6 * WETH_DECIMALS) / usdcPerOneWeth6;
  if (amount > maxIntentWeth) amount = maxIntentWeth;
  if (amount < minTradeWeth) {
    return {
      action: "hold",
      reason: `computed sell size (${amount} WETH-units) is below the dust floor (${minTradeWeth})`,
      intentAmount: 0n,
      ...withDrift,
    };
  }
  return {
    action: "sell",
    reason:
      `deployed capital is ${driftBps}bps over target (trigger ${policy.rebalanceTriggerBps}bps) — ` +
      `withdrawing ${amount} WETH-units of collateral, capped by risk budget and safety ceiling`,
    intentAmount: amount,
    ...withDrift,
  };
}
