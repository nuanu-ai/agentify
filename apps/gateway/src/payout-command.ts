/**
 * Prints the operator's payout (`payout-listing.ts`) at the terminal: every
 * payout split recorded on this gateway's network, each merchant's share to
 * their wallet and the commission last, for a person to send from a wallet of
 * their own. It sends nothing, signs nothing and writes nothing, and prints no
 * transaction where the listing refuses one.
 */

import type { Gateway } from "./app/gateway.js";
import { payoutListing } from "./payout-listing.js";

const USAGE = [
  "Usage: pnpm --filter @agentify/gateway payout",
  "",
  "Prints the transactions that pay out every payout split recorded on this",
  "network, Agentify's commission included, for a person to send from a wallet",
  "of their own. It sends nothing, signs nothing and writes nothing.",
].join("\n");

export async function runPayout(
  argv: readonly string[],
  application: Gateway,
  say: (line: string) => void,
): Promise<number> {
  const [asked] = argv;
  if (asked !== undefined) {
    say(USAGE);
    return asked === "--help" || asked === "-h" ? 0 : 2;
  }

  const listing = await payoutListing(application);
  switch (listing.kind) {
    case "sandbox":
      say(
        "This gateway is a sandbox: nothing settles there and no payout split is ever deployed, so there is nothing to pay out.",
      );
      return 1;
    case "refused":
      say(`No payout is printed: ${listing.why}.`);
      return 1;
    case "nothing_recorded":
      say(
        `No payout split is recorded on ${listing.chain.name} (${listing.chain.id}), so there is nothing to pay out.`,
      );
      return 0;
    case "listed": {
      const { chain, parts } = listing;
      say(
        `Payout splits recorded on ${chain.name} (${chain.id}): ${listing.splits}.` +
          ` Send every transaction below on ${chain.name} only, from a wallet of your own, which pays the gas;` +
          " this command sends nothing and signs nothing.",
      );
      parts.forEach((part, at) => {
        say("");
        say(`Payout ${at + 1} of ${parts.length}`);
        say(`To: ${part.to}`);
        say("Amount: 0");
        say(`Data: ${part.data}`);
        say("Pays out:");
        for (const split of part.splits) {
          say(`  ${split.address} of ${split.merchantId}, to ${split.merchantWallet}`);
        }
        say(`  and the commission, to ${part.commissionWallets.join(" and ")}`);
      });
      return 0;
    }
  }
}
