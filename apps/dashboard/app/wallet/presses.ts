/**
 * What a page remembers of the presses of Coinbase Wallet's buttons, kept
 * with the wallet's provider. The provider holds one session with its window
 * for the whole page, and is made once per chain and kept while the page is
 * loaded, so the presses of both buttons, and of a settings screen drawn again
 * after the merchant went elsewhere and came back, share one memory.
 *
 * Every press starts by ending that session, so a press begun while another
 * waits leaves the waiting one unable to read its answer, whatever the
 * merchant did in the window.
 */
export interface PagePresses {
  /** Begins a press, and answers whether no press has begun since. */
  begin(): () => boolean;
  /** Payout presses whose answer has not come back. */
  payoutsWaiting: number;
  /** A payout press on this page came back sent. */
  payoutSent: boolean;
  /** A payout press on this page came back without the page being able to know whether it went out. */
  payoutUnknown: boolean;
}

const kept = new WeakMap<object, PagePresses>();

/** The memory kept with `provider`, made on its first press. */
export function pressesOf(provider: object): PagePresses {
  const already = kept.get(provider);
  if (already !== undefined) return already;
  let begun = 0;
  const presses: PagePresses = {
    begin: () => {
      begun += 1;
      const mine = begun;
      return () => mine === begun;
    },
    payoutsWaiting: 0,
    payoutSent: false,
    payoutUnknown: false,
  };
  kept.set(provider, presses);
  return presses;
}
