/**
 * Reads the gateway's configuration from the environment and shows its
 * facilitator key to Coinbase, as the gateway's own start does, without
 * starting anything. Activation runs it with the application's environment
 * before it stops the running release:
 *
 *   pnpm --silent --filter @agentify/gateway facilitator-key
 *
 * Exits 1 with the reason on stderr when the gateway refuses the
 * configuration, the key cannot sign or Coinbase refuses it, and 0 otherwise,
 * saying so when Coinbase could not be asked.
 */

import { loadConfig } from "./config.js";
import { checkFacilitatorKey } from "./facilitator-key-check.js";

try {
  const checked = await checkFacilitatorKey(loadConfig(process.env).payment);
  if (checked.outcome === "refused") {
    console.error(checked.said);
    process.exitCode = 1;
  } else {
    console.log(checked.said);
  }
} catch (thrown) {
  console.error(thrown instanceof Error ? thrown.message : String(thrown));
  process.exitCode = 1;
}
