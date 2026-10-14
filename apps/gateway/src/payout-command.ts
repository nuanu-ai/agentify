/**
 * Prints the operator's payout: the transactions that pay out every payout
 * split of this gateway's network that can hold money, each merchant's share
 * to their wallet and the commission last, for a person to send from a wallet
 * of their own. It sends nothing, holds no key, writes nothing and takes no
 * work off the queue, so Agentify is paid only when somebody sends what it
 * prints.
 *
 * Nothing is printed where the gateway would refuse to start on the registry,
 * since a transaction built from splits the code disagrees with may pay out
 * another contract than the one buyers paid.
 */

import type { Gateway } from "./app/gateway.js";
import { RefusedToStart } from "./app/recorded-splits.js";
import { operatorPayouts } from "./split/payout.js";

const USAGE = [
  "Usage: pnpm --filter @agentify/gateway payout",
  "",
  "Prints the transactions that pay out every payout split of this network that",
  "can hold money, Agentify's commission included, for a person to send from a",
  "wallet of their own. It sends nothing, holds no key and writes nothing.",
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

  const { surfaceMode, payoutSplit: network, payoutSplitNetworks } = application.runtime.config;
  if (surfaceMode === "sandbox") {
    say(
      "This gateway is a sandbox: nothing settles there and no payout split is ever deployed, so there is nothing to pay out.",
    );
    return 1;
  }

  try {
    await application.refuseUnlessTheSplitsAgree();
  } catch (thrown) {
    if (thrown instanceof RefusedToStart) {
      say(`No payout is printed: ${thrown.message}.`);
      return 1;
    }
    throw thrown;
  }

  const splits = await application.splitsToPayOut();
  if (splits.length === 0) {
    say(`No payout split on ${network.network} can hold money, so there is nothing to pay out.`);
    return 0;
  }

  const parts = operatorPayouts(network, splits, payoutSplitNetworks);
  say(
    `Payout splits on ${network.network} that can hold money: ${splits.length}.` +
      " Send every transaction below on that chain from a wallet of your own, which pays the gas;" +
      " this command sends nothing and holds no key.",
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
    const commission = [...new Set(part.splits.map((split) => split.commissionWallet))];
    say(`  and the commission, to ${commission.join(" and ")}`);
  });
  return 0;
}
