import { loadConfig } from "./config.js";
import { buildContext } from "./context.js";
import { startRuntime } from "./runtime.js";
import * as log from "./logger.js";

async function main() {
  const cfg = loadConfig();
  const ctx = await buildContext(cfg);
  await startRuntime(ctx);
}

main().catch((err) => {
  log.error("fatal startup error", { error: err instanceof Error ? (err.stack ?? err.message) : String(err) });
  process.exitCode = 1;
});
