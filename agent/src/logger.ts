/**
 * Structured, line-oriented logging: one JSON-serializable event per line, timestamped and
 * leveled, so the runtime's transcript is greppable and safe to pipe into a log aggregator.
 * `step` marks an on-chain action (a read that gates a decision, or a transaction) — the
 * category a reviewer replaying the transcript cares about most.
 */

type Level = "info" | "warn" | "error" | "step";

function replacer(_key: string, value: unknown) {
  return typeof value === "bigint" ? value.toString() : value;
}

function emit(level: Level, message: string, data?: Record<string, unknown>) {
  const line = `[${new Date().toISOString()}] [${level.toUpperCase()}] ${message}`;
  if (data !== undefined) {
    console.log(line, JSON.stringify(data, replacer));
  } else {
    console.log(line);
  }
}

export const info = (message: string, data?: Record<string, unknown>) => emit("info", message, data);
export const warn = (message: string, data?: Record<string, unknown>) => emit("warn", message, data);
export const error = (message: string, data?: Record<string, unknown>) => emit("error", message, data);
export const step = (message: string, data?: Record<string, unknown>) => emit("step", message, data);
