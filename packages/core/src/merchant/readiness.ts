/**
 * What a merchant must have before their cards are sold, on each surface. Every
 * path that decides or says whether a merchant can sell asks this one rule: the
 * gateway's publish door and its check at every sale, the dashboard's screens
 * and its WooCommerce import, and any shop connector. It lives here because the
 * gateway and the dashboard need the same answer about the same merchant.
 *
 * A seller name is asked on every surface, because a payment request names its
 * seller in the sandbox as anywhere else. A payout wallet is asked wherever a
 * payment settles, which is the test and the live surface but not the sandbox,
 * where nothing settles. The operator's approval is asked on the live surface
 * alone.
 *
 * The answer is the codes a refused publish carries on the wire, so every
 * surface names one missing thing with one word. Only their type is imported,
 * so the package keeps no runtime dependency.
 */

import type { MerchantFinding } from "@nuanu-ai/agentify-contracts";
import type { SurfaceMode } from "../deployment/environment.js";

/**
 * A fact the caller did not read. A symbol rather than `undefined`, so a caller
 * cannot leave a fact out by accident and have it read as unknown, and rather
 * than a word, since a seller could be named "unknown".
 */
export const UNKNOWN: unique symbol = Symbol("unknown");
type Unknown = typeof UNKNOWN;

/** What a caller knows about one merchant. */
export interface MerchantFacts {
  /** The name their products are sold under; null where none is set. */
  readonly sellerName: string | null | Unknown;
  /** The address their sales are paid into; null where none is set. */
  readonly payoutWallet: string | null | Unknown;
  /** Whether the operator has admitted them to the live catalog. */
  readonly liveApproval: boolean | Unknown;
}

/**
 * The rule's answer about one merchant on one surface.
 *
 * `missing` and `unknown` are both drawn from `asked` and never share a code:
 * a fact the caller could not read is not a fact that is absent, and the two
 * are said differently wherever they are said at all.
 */
export interface Readiness {
  /** What this surface asks of any merchant, in the order a refusal names it. */
  readonly asked: readonly MerchantFinding[];
  /** What this merchant lacks among it. */
  readonly missing: readonly MerchantFinding[];
  /** What the caller could not read among it, so cannot say either way. */
  readonly unknown: readonly MerchantFinding[];
}

const ASKED: Readonly<Record<SurfaceMode, readonly Exclude<MerchantFinding, "no_seller_site">[]>> =
  {
    sandbox: ["no_seller_name"],
    test: ["no_seller_name", "no_payout_wallet"],
    live: ["no_seller_name", "no_payout_wallet", "no_operator_approval"],
  };

const isSet = (value: string | null | Unknown): boolean | Unknown =>
  value === UNKNOWN ? UNKNOWN : value !== null;

/** What this merchant lacks on this surface, and what the caller could not tell. */
export function readinessOf(facts: MerchantFacts, surface: SurfaceMode): Readiness {
  // Keyed by every code there is, so a code added to the contract does not
  // compile until somebody says which fact answers it. A shop's site is asked
  // of a parcel's card alone, never of a merchant on a surface, so the publish
  // door asks it with the card in hand and this rule does not hold it.
  const held: Readonly<Record<Exclude<MerchantFinding, "no_seller_site">, boolean | Unknown>> = {
    no_seller_name: isSet(facts.sellerName),
    no_payout_wallet: isSet(facts.payoutWallet),
    no_operator_approval: facts.liveApproval,
  };
  const asked = ASKED[surface];
  return {
    asked,
    missing: asked.filter((finding) => held[finding] === false),
    unknown: asked.filter((finding) => held[finding] === UNKNOWN),
  };
}
