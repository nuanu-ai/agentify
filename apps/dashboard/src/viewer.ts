/**
 * What a screen knows about whoever it is drawn for, and the rule that decides
 * what holds a card off sale as far as a screen knows. Where a screen would
 * like to say more than the API supports, it says the weaker thing; `words.ts`
 * carries those cases.
 */

import { type Readiness, readinessOf, type SurfaceMode, UNKNOWN } from "@agentify/core";
import { MERCHANT_FINDINGS } from "@nuanu-ai/agentify-contracts";
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
   * refused. Absent where the screen did not ask.
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
