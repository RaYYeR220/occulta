function formatTokenAmount(raw: bigint, decimals: number, fractionDigits: number): string {
  const negative = raw < 0n;
  const abs = negative ? -raw : raw;
  const base = 10n ** BigInt(decimals);
  const whole = abs / base;
  const frac = (abs % base).toString().padStart(decimals, "0").slice(0, fractionDigits);
  return `${negative ? "-" : ""}${whole.toLocaleString("en-US")}.${frac}`;
}

export function formatUsdcUnits(raw: bigint, decimals = 6): string {
  return formatTokenAmount(raw, decimals, 2);
}

/**
 * `NetSettler`'s aggregate net does not have a fixed unit — it is USDC for a BUY and WETH for a
 * SELL, because {@link OccultaExecutor}'s two legs start from different assets: a BUY's net is
 * the USDC capital swapped into WETH collateral, a SELL's net is the WETH collateral withdrawn
 * and swapped back to USDC (see `contracts/execution/OccultaExecutor.sol`). USDC has 6 decimals,
 * WETH has 18 — formatting a WETH-scale raw value as if it were USDC prints a number roughly a
 * billion times too large. Pick the scale from the direction so that can't happen.
 */
export function formatNetAmount(raw: bigint, isBuy: boolean): { formatted: string; unit: "USDC" | "WETH" } {
  return isBuy
    ? { formatted: formatTokenAmount(raw, 6, 2), unit: "USDC" }
    : { formatted: formatTokenAmount(raw, 18, 4), unit: "WETH" };
}

/** Aave's `*Base` account-data fields are USD, 8-decimal fixed point. */
export function formatUsdBase(raw: bigint): string {
  const base = 100_000_000n;
  const whole = raw / base;
  const frac = (raw % base).toString().padStart(8, "0").slice(0, 2);
  return `${whole.toLocaleString("en-US")}.${frac}`;
}

export function shortAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

const MAX_UINT256 = (1n << 256n) - 1n;

/** Aave's own zero-debt convention: `healthFactor` is `type(uint256).max` when there is no debt. */
export function formatHealthFactor(raw: bigint): string {
  if (raw === MAX_UINT256) return "∞ — no debt";
  const scaled = Number(raw) / 1e18;
  return scaled.toFixed(2);
}
