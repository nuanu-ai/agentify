/**
 * What both stores refuse about a split before they record it, in the same
 * words, so a refusal reads the same whichever store a gateway runs on.
 */

import type { PayoutWalletWrite } from "../ports/store.js";
import type { PayoutSplit } from "../split/parameters.js";

/**
 * The splits a wallet write records, each once, or a refusal where one is not
 * this merchant's split of the address it is written with: the registry says
 * which wallet each split pays, and a wallet written beside another's split
 * would have buyers pay somewhere the merchant was never told of.
 */
export function splitsOfTheWrite(
  merchantId: string,
  next: PayoutWalletWrite,
): readonly PayoutSplit[] {
  const written = [
    { address: next.address, split: next.split },
    ...(next.pending === null
      ? []
      : [{ address: next.pending.address, split: next.pending.split }]),
  ];
  for (const { address, split } of written) {
    if (split.merchantId !== merchantId || split.merchantWallet !== address) {
      throw new Error(
        `the split given for ${merchantId}'s wallet ${address} is ${split.merchantId}'s split of ${split.merchantWallet}, so neither the wallet nor the split was written`,
      );
    }
  }
  const once = new Map(written.map(({ split }) => [split.address, split]));
  return [...once.values()];
}

/**
 * The refusal for a split whose merchant, wallet and network are already
 * recorded at another address, or whose address is already recorded for
 * another merchant or wallet: one of the two would name a contract nobody was
 * told of, and a recorded split is never rewritten.
 */
export function recordedOtherwise(split: PayoutSplit): Error {
  return new Error(
    `the payout split of ${split.merchantId}'s wallet ${split.merchantWallet} on ${split.network} is already recorded otherwise than as ${split.address}, and a recorded split is never rewritten, so nothing was written`,
  );
}
