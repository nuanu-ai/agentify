/**
 * The registry of payout splits as a gateway meets it when it starts: checked
 * against the network's payout split in the code before anything else runs,
 * then given the split of every wallet that has none. And the journal line
 * every newly recorded split gets, from whichever write recorded it.
 */

import { isAddress } from "viem";
import type { RecordedPayoutSplit, StoredPayoutWallet } from "../ports/store.js";
import type { PayoutSplitNetwork } from "../split/networks.js";
import { type PayoutSplit, payoutSplitFor } from "../split/parameters.js";
import { type NotAPayoutWallet, whyNotAPayoutWallet } from "../split/wallet-rule.js";
import type { Runtime } from "./runtime.js";

/**
 * The gateway does not start on this registry: it disagrees with the
 * network's payout split in the code, holds a wallet no split can be made
 * for, or the splits it lacks could not be recorded. The message says what,
 * and on which network.
 */
export class RefusedToStart extends Error {
  override readonly name = "RefusedToStart";
}

/** The splits recorded for a wallet in force and a wallet waiting. */
const recordedOf = (wallet: StoredPayoutWallet): readonly RecordedPayoutSplit[] => [
  ...(wallet.split === null ? [] : [wallet.split]),
  ...(wallet.pending?.split == null ? [] : [wallet.pending.split]),
];

/** Whether a recorded split is, in every parameter, the one the code makes today. */
const madeToday = (recorded: RecordedPayoutSplit, today: PayoutSplit | null): boolean =>
  today !== null &&
  (Object.keys(today) as (keyof PayoutSplit)[]).every((key) => recorded[key] === today[key]);

/** Today's split of this merchant's wallet, or null where the code could make none. */
const todaysSplitOf = (
  network: PayoutSplitNetwork,
  merchantId: string,
  wallet: string,
): PayoutSplit | null => {
  try {
    return payoutSplitFor(network, merchantId, wallet);
  } catch {
    return null;
  }
};

/**
 * Why a merchant's share could never come back from this wallet, held against
 * every network of the table and every split recorded, or null where the
 * wallet rule takes it. Throws on a string that is not an address.
 */
export async function whyTheRuleRefuses(
  runtime: Runtime,
  wallet: string,
): Promise<NotAPayoutWallet | null> {
  const someSplit = await runtime.store.payoutSplitAt(wallet);
  return whyNotAPayoutWallet(wallet, {
    networks: runtime.config.payoutSplitNetworks,
    splits: someSplit === null ? [] : [someSplit.address],
  });
}

/**
 * Throws `RefusedToStart` where the registry is not what this network's
 * payout split in the code makes: where the store reads splits on another
 * network than the split is made on, where it holds a split of another network,
 * or a split of a wallet in force or waiting is not, in every parameter, the
 * split the code makes today for that merchant and wallet, whether a
 * commission wallet, the rate or the factory changed, or the way a salt and an
 * address are derived; or where any split recorded on the network pays a
 * wallet the wallet rule refuses, to which the operator's payout would send
 * the merchant's share for good. Until a change of rate is
 * designed, this refusal is what makes an edit to those constants loud rather
 * than a second split beside every merchant's first.
 *
 * It reads and writes nothing else, so a start asks it before anything, and
 * the operator's payout can ask it alone.
 */
export async function refuseUnlessTheSplitsAgree(runtime: Runtime): Promise<void> {
  const why = await whyTheSplitsDisagree(runtime);
  if (why !== null) {
    throw new RefusedToStart(
      runtime.config.surfaceMode === "sandbox" ? `${why}. ${THE_SANDBOX_WAY_OUT}` : why,
    );
  }
}

/**
 * Said after a refusal on a laptop's sandbox, where no split holds money and
 * a recorded row cannot be deleted: its database can go instead.
 */
const THE_SANDBOX_WAY_OUT =
  "This is a sandbox, where no payout split holds money: `docker compose down -v` drops its database, with every split recorded in it, and the next `docker compose up` starts from nothing";

/** Why `refuseUnlessTheSplitsAgree` refuses, or null where the registry agrees. */
async function whyTheSplitsDisagree(runtime: Runtime): Promise<string | null> {
  const network = runtime.config.payoutSplit;
  if (runtime.store.network !== network.network) {
    return `this gateway's store reads payout splits on ${runtime.store.network} and its payout split is made on ${network.network}, so every wallet would read as having no split and nothing would sell, and the gateway does not start`;
  }
  const elsewhere = (await runtime.store.networksWithPayoutSplits()).filter(
    (recorded) => recorded !== network.network,
  );
  if (elsewhere.length > 0) {
    return `the database records payout splits on ${elsewhere.join(", ")}, and this gateway takes payments on ${network.network}; a database holding another network's payout splits is not this channel's database, so the gateway does not start`;
  }

  const disagreeing: RecordedPayoutSplit[] = [];
  for (const merchant of await runtime.store.merchants()) {
    for (const split of recordedOf(merchant.payoutWallet)) {
      if (!madeToday(split, todaysSplitOf(network, merchant.id, split.merchantWallet))) {
        disagreeing.push(split);
      }
    }
  }
  const [first] = disagreeing;
  if (first !== undefined) {
    return `${disagreeing.length} recorded split${disagreeing.length === 1 ? "" : "s"} of a wallet in force or waiting on ${network.network}, beginning with ${first.address}, ${disagreeing.length === 1 ? "is" : "are"} no longer what this code makes for that merchant and wallet: the commission wallet or the rate, the factory, or the way a salt and an address are derived changed since, and there is no way yet to move merchants onto new splits, so the gateway does not start`;
  }

  // Every recorded split is in the operator's payout, so every one is held
  // to the rule, not only those buyers pay now.
  const refused: { readonly split: RecordedPayoutSplit; readonly is: NotAPayoutWallet }[] = [];
  for (const split of await runtime.store.payoutSplitsOn(network.network)) {
    const is = await whyTheRuleRefuses(runtime, split.merchantWallet);
    if (is !== null) {
      refused.push({ split, is });
    }
  }
  const [worst] = refused;
  if (worst !== undefined) {
    return `${refused.length} recorded split${refused.length === 1 ? "" : "s"} on ${network.network} ${refused.length === 1 ? "pays" : "pay"} a wallet the wallet rule refuses, beginning with ${worst.split.address} of ${worst.split.merchantId}, which pays ${worst.split.merchantWallet}, refused as ${worst.is}: a payout would send that merchant's share where it could never come back from, so the gateway does not start`;
  }
  return null;
}

/**
 * Records the split of every wallet in force and every wallet waiting that
 * has none, touching no merchant and no order, and says how many where it
 * recorded any. Two gateways starting at once record each split once. Every
 * write of a wallet records its split with it, so a wallet found here without
 * one was written by something that does not: a hand, or a gateway that kept
 * no registry.
 */
export async function recordMissingSplits(runtime: Runtime): Promise<void> {
  const network = runtime.config.payoutSplit;
  const missing: PayoutSplit[] = [];
  for (const merchant of await runtime.store.merchants()) {
    const { address, split, pending } = merchant.payoutWallet;
    const unrecorded = [
      ...(address !== null && split === null ? [address] : []),
      ...(pending !== null && pending.split === null ? [pending.address] : []),
    ];
    for (const wallet of unrecorded) {
      if (!isAddress(wallet)) {
        throw new RefusedToStart(
          `${merchant.id} is paid at ${wallet}, which is no address, so no payout split can be made for it on ${network.network}, and the gateway does not start`,
        );
      }
      const is = await whyTheRuleRefuses(runtime, wallet);
      if (is !== null) {
        console.error(
          `[gateway] ${merchant.id}'s payout wallet ${wallet} is refused by the wallet rule as ${is}: a merchant's share could never come back from it, so no payout split is recorded for it, and nothing of theirs sells on it until they set another wallet`,
        );
        continue;
      }
      // The rule refuses every address the split could not be made for.
      missing.push(payoutSplitFor(network, merchant.id, wallet));
    }
  }
  const recorded = await runtime.store
    .recordPayoutSplits(missing, runtime.clock())
    .catch((thrown: unknown) => {
      throw new RefusedToStart(
        `recording the payout splits of ${missing.length} wallet${missing.length === 1 ? "" : "s"} set without one failed (${thrown instanceof Error ? thrown.message : String(thrown)}), so the gateway does not start`,
        { cause: thrown },
      );
    });
  if (recorded.length > 0) {
    console.log(
      `[gateway] recorded ${recorded.length} payout split${recorded.length === 1 ? "" : "s"} of wallets that had none`,
    );
  }
  journal(recorded);
}

/**
 * One line per split recorded for the first time, with every parameter it was
 * recorded with. A database restored from a copy older than the row loses the
 * row, and with it the only record of a split nobody has created yet; these
 * lines are what it is entered again from.
 */
export function journal(recorded: readonly RecordedPayoutSplit[]): void {
  for (const split of recorded) {
    console.log(`[gateway] payout split recorded: ${JSON.stringify(split)}`);
  }
}
