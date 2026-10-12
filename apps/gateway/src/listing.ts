/**
 * The listing check, wired to the network. It takes the public address of a
 * running gateway, which the validation endpoint must be able to reach from
 * the internet:
 *
 *   pnpm smoke:listing https://agentify.example
 *   pnpm smoke:listing https://agentify.example itm_4d21bb
 *
 * No database, no key, no wallet, nothing spent.
 */

import { overTheNetwork, runListingCheck } from "./listing-command.js";

process.exitCode = await runListingCheck(process.argv.slice(2), overTheNetwork(), (line) => {
  console.log(line);
});
