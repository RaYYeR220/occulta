export function formatUsdcUnits(raw: bigint, decimals = 6): string {
  const negative = raw < 0n;
  const abs = negative ? -raw : raw;
  const base = 10n ** BigInt(decimals);
  const whole = abs / base;
  const frac = (abs % base).toString().padStart(decimals, "0").slice(0, 2);
  return `${negative ? "-" : ""}${whole.toLocaleString("en-US")}.${frac}`;
}

/** Aave's `*Base` account-data fields are USD, 8-decimal fixed point. */
export function formatUsdBase(raw: bigint): string {
  const base = 100_000_000n;
  const whole = raw / base;
  const frac = (raw % base).toString().padStart(8, "0").slice(0, 2);
  return `$${whole.toLocaleString("en-US")}.${frac}`;
}

const MAX_UINT256 = (1n << 256n) - 1n;

/** Aave's own zero-debt convention: `healthFactor` is `type(uint256).max` when there is no debt. */
export function formatHealthFactor(raw: bigint): string {
  if (raw === MAX_UINT256) return "no debt";
  const scaled = Number(raw) / 1e18;
  return scaled.toFixed(2);
}
