/**
 * The registry of payout splits as a gateway meets it when it starts: checked
 * against the network's payout split in the code before anything else runs,
 * then given the split of every wallet set before splits existed. And the
 * journal line every newly recorded split gets, from whichever write recorded
 * it.
 */

import type { RecordedPayoutSplit, StoredPayoutWallet } from "../ports/store.js";
import type { PayoutSplitNetwork } from "../split/networks.js";
import { type PayoutSplit, payoutSplitFor } from "../split/parameters.js";
import type { Runtime } from "./runtime.js";

/**
 * The gateway does not start on this registry: it disagrees with the
 * network's payout split in the code, or holds a wallet no split can be made
 * for. The message says what, and on which network.
 */
export class RefusedToStart extends Error {
  override readonly name = "RefusedToStart";
}

/** The splits recorded for a wallet in force and a wallet waiting. */
const recordedOf = (wallet: StoredPayoutWallet): readonly RecordedPayoutSplit[] => [
  ...(wallet.split === null ? [] : [wallet.split]),
  ...(wallet.pending?.split == null ? [] : [wallet.pending.split]),
];

/** Whether a split names this network's commission wallet, rate, owner, incentive and factory. */
const onTheseTerms = (split: PayoutSplit, today: PayoutSplit): boolean =>
  split.network === today.network &&
  split.commissionWallet === today.commissionWallet &&
  split.merchantAllocation === today.merchantAllocation &&
  split.commissionAllocation === today.commissionAllocation &&
  split.totalAllocation === today.totalAllocation &&
  split.distributionIncentive === today.distributionIncentive &&
  split.owner === today.owner &&
  split.factory === today.factory;

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
 * Throws `RefusedToStart` where the registry is not what this network's
 * payout split in the code makes: it holds a split of another network; a
 * split of a wallet in force or waiting names another commission wallet,
 * rate, owner, incentive or factory; or the code no longer derives such a
 * split's salt and address from its merchant, network and wallet. Until a
 * change of rate is designed, this refusal is what makes an edit to those
 * constants loud rather than a second split beside every merchant's first.
 *
 * It reads and writes nothing else, so a start asks it before anything, and
 * the operator's payout command can ask it alone.
 */
export async function refuseUnlessTheSplitsAgree(runtime: Runtime): Promise<void> {
  const network = runtime.config.payoutSplit;
  const elsewhere = (await runtime.store.networksWithPayoutSplits()).filter(
    (recorded) => recorded !== network.network,
  );
  if (elsewhere.length > 0) {
    throw new RefusedToStart(
      `the database records payout splits on ${elsewhere.join(", ")}, and this gateway takes payments on ${network.network}; the same formula gives the same addresses on both chains, so it would name another network's splits, with another commission wallet inside, as its own payment addresses, and it does not start`,
    );
  }

  const changed: RecordedPayoutSplit[] = [];
  let underived: RecordedPayoutSplit | null = null;
  for (const merchant of await runtime.store.merchants()) {
    for (const split of recordedOf(merchant.payoutWallet)) {
      const today = todaysSplitOf(network, merchant.id, split.merchantWallet);
      if (today === null || !onTheseTerms(split, today)) {
        changed.push(split);
      } else if (split.salt !== today.salt || split.address !== today.address) {
        underived ??= split;
      }
    }
  }
  if (changed.length > 0) {
    throw new RefusedToStart(
      `the commission wallet or the rate of the payout split on ${network.network}, or the factory it is made by, is not what the registry recorded: ${changed.length} recorded split${changed.length === 1 ? "" : "s"} of a wallet in force or waiting ${changed.length === 1 ? "names" : "name"} other terms, beginning with ${changed[0]?.address}, and there is no way yet to move merchants onto new splits, so the gateway does not start`,
    );
  }
  if (underived !== null) {
    throw new RefusedToStart(
      `the payout split recorded at ${underived.address} for ${underived.merchantId} on ${network.network} is no longer what this code derives from its merchant, network and wallet, so new merchants would be given addresses computed another way, and the gateway does not start`,
    );
  }
}

/**
 * Records the split of every wallet in force and every wallet waiting that
 * has none, as the release before splits left them, touching no merchant and
 * no order, and says how many where it recorded any. Two gateways starting
 * at once record each split once. A count after the release that brought
 * splits points at a write that skipped its split.
 */
export async function recordSplitsOfWalletsSetBefore(runtime: Runtime): Promise<void> {
  const network = runtime.config.payoutSplit;
  const missing: PayoutSplit[] = [];
  for (const merchant of await runtime.store.merchants()) {
    const { address, split, pending } = merchant.payoutWallet;
    const unrecorded = [
      ...(address !== null && split === null ? [address] : []),
      ...(pending !== null && pending.split === null ? [pending.address] : []),
    ];
    for (const wallet of unrecorded) {
      const made = todaysSplitOf(network, merchant.id, wallet);
      if (made === null) {
        throw new RefusedToStart(
          `${merchant.id} is paid at ${wallet}, for which no payout split can be made on ${network.network}, so the gateway does not start`,
        );
      }
      missing.push(made);
    }
  }
  const recorded = await runtime.store.recordPayoutSplits(missing, runtime.clock());
  if (recorded.length > 0) {
    console.log(
      `[gateway] recorded ${recorded.length} payout split${recorded.length === 1 ? "" : "s"} of wallets set before their splits were`,
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
