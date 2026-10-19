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

import { facilitatorClientFor, refuseUnlessCoinbaseTakesTheKey } from "./adapters/x402/client.js";
import { isCdpFacilitator, loadConfig } from "./config.js";

try {
  const { payment } = loadConfig(process.env);
  if (!isCdpFacilitator(payment.facilitatorUrl)) {
    console.log(
      `${payment.facilitatorUrl} is not Coinbase's facilitator, so there is no key to ask Coinbase about`,
    );
  } else {
    const unconfirmed = await refuseUnlessCoinbaseTakesTheKey(facilitatorClientFor(payment), fetch);
    console.log(unconfirmed ?? "Coinbase takes the key in CDP_API_KEY_ID and CDP_API_KEY_SECRET");
  }
} catch (thrown) {
  console.error(thrown instanceof Error ? thrown.message : String(thrown));
  process.exitCode = 1;
}
