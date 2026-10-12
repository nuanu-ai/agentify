/**
 * The bootstrap purchase, wired to the network and to a wallet. It buys for
 * real from a running gateway so that the products are catalogued by Coinbase's
 * Bazaar, which happens on the first settle through the CDP facilitator and on
 * nothing else, and then watches the catalog and says what it saw.
 *
 *   AGENTIFY_SMOKE=1 GATEWAY_URL=https://agentify.example SMOKE_BUYER_KEY=0x… \
 *     pnpm smoke:bootstrap --confirm
 *
 * Nothing is spent without `--confirm`, and no run spends more than
 * `SMOKE_TOTAL_USD`. The command itself lives in `bootstrap-command.ts` and is
 * tested offline; it reads the key and refuses a bad one before anything here
 * touches it.
 */

import { overTheNetwork, runBootstrap } from "./bootstrap-command.js";

process.exitCode = await runBootstrap(
  process.argv.slice(2),
  process.env,
  (settings) => overTheNetwork(settings),
  (line) => {
    console.log(line);
  },
);
