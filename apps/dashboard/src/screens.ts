/**
 * What a screen knows about whoever it is drawn for, the rule that decides what
 * holds a card off sale as far as a screen knows, and the two pages the string
 * gate and the not-found answer draw. Where a screen would like to say more
 * than the API supports, it says the weaker thing; `words.ts` carries those
 * cases.
 */

import { type Readiness, readinessOf, type SurfaceMode, UNKNOWN } from "@agentify/core";
import { MERCHANT_FINDINGS } from "@nuanu-ai/agentify-contracts";
import { bare, brandLockup, escaped, page } from "./html.js";
import type { PayoutWallet } from "./payout-wallet.js";
import type { Unset } from "./words.js";

export interface Viewer {
  /** As derived from its gateway. */
  readonly mode: SurfaceMode;
  /** "" when mounted at the root of its origin. */
  readonly base: string;
  readonly who: string;
  /** An interactive session is always confirmed by the link that opened it. */
  readonly confirmed: boolean;
  /**
   * Where the screen asked the gateway for it. Null is a merchant who has
   * chosen none, and until one is set every card their code publishes is
   * refused. Absent where the screen did not ask (the keys, for the reason
   * `html.ts` gives).
   */
  readonly sellerName?: string | null;
  /**
   * Present only where the screen asked the gateway for the address: the cards,
   * which say what holds a card off sale. A page that did not ask must not tell
   * a merchant they have set no address.
   */
  readonly payout?: PayoutWallet;
  /**
   * Where the screen asked; it matters only on the live channel, where
   * publishing waits for it.
   */
  readonly liveApproval?: boolean;
}

/**
 * The rule is the gateway's own (`readinessOf` in the core), so no screen holds
 * an opinion about which setting publishing needs where. What the screen did
 * not read goes in as unknown, the operator's approval included: a page that
 * did not read something must not say anything either way about it.
 */
export const readinessSeenBy = (viewer: Viewer): Readiness =>
  readinessOf(
    {
      sellerName: viewer.sellerName === undefined ? UNKNOWN : viewer.sellerName,
      payoutWallet: viewer.payout === undefined ? UNKNOWN : viewer.payout.wallet,
      liveApproval: viewer.liveApproval === undefined ? UNKNOWN : viewer.liveApproval,
    },
    viewer.mode,
  );

/** As far as this screen knows. */
export const refusedForNoName = (viewer: Viewer): boolean =>
  readinessSeenBy(viewer).missing.includes(MERCHANT_FINDINGS.NO_SELLER_NAME);

/**
 * What is missing that the merchant sets in Settings: everything the rule finds
 * missing except the operator's approval, which nobody sets there (on live,
 * where the cards and settings screens read it, it is said on its own). Nothing
 * else may be dropped, because this is the list a merchant is told to go and
 * set.
 */
export const unsetIn = (door: Readiness): readonly Unset[] =>
  door.missing.filter(
    (finding): finding is Unset => finding !== MERCHANT_FINDINGS.NO_OPERATOR_APPROVAL,
  );

/**
 * In the dashboard's own frame: the person is still in their dashboard, and the
 * logo and the one button lead back to the cards.
 */
export const notFoundScreen = (viewer: Viewer): string =>
  page({
    mode: viewer.mode,
    base: viewer.base,
    who: viewer.who,
    confirmed: viewer.confirmed,
    tab: null,
    title: "There is no such page",
    home: `${viewer.base}/cards`,
    body: `
  <div class="lede">
    <div>
      <h1>There is no such page</h1>
      <p>The link may have a typo or be out of date. Every section of your dashboard is in the menu.</p>
    </div>
  </div>
  <div class="connect-actions">
    <a class="button button-primary" href="${escaped(viewer.base)}/cards">Back to the dashboard</a>
  </div>
`,
  });

/**
 * Nothing the form sent was done. It says the page could not be matched rather
 * than that it was drawn for somebody else, because an old tab pressed by its
 * own owner gets this too. It names the address signed in now, never the one
 * the form claimed, and is a bare page because the person now signed in may own
 * no merchant.
 */
export const notDrawnForYouScreen = (
  base: string,
  mode: SurfaceMode,
  who: string,
  start: string,
): string =>
  bare(
    base,
    "Nothing was changed",
    `<div class="gate">
${brandLockup("/")}
<div class="gate-card">
  <h1>Nothing was changed</h1>
  <p>What you pressed was not done, because the page it came from could not be matched to the address signed in on this browser now, <strong>${escaped(who)}</strong>. Open the screen again to make the change as this address.</p>
  <a class="button button-primary" href="${escaped(start)}">Continue</a>
</div>
</div>`,
    mode,
    null,
  );
