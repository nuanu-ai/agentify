/**
 * What a merchant must have before their cards are sold, on each surface.
 *
 * One rule, asked by every path that decides or says whether a merchant can
 * sell: the gateway's publish door and its check at every later sale, the
 * cabinet's screens and its WooCommerce import, and any shop connector after
 * them. Two copies of a rule are two rules the day one of them is edited, and
 * that has happened here: the door refused a missing name on every surface
 * while a decision and two public pages said the name was asked for live
 * publication alone. The rule lives in this package rather than in the gateway
 * because the cabinet needs the same answer about the same merchant, the reason
 * `deployment/environment.ts` gives for itself, and it is pure, which is what
 * this package is for.
 *
 * The rule (ADR-0026 §5): a seller name on every surface, because a payment
 * request names its seller in the sandbox exactly as it does anywhere else; a
 * payout wallet wherever a payment settles, which is the test and the live
 * surface and not the sandbox, where nothing settles and there is no money to
 * send (ADR-0008); and the operator's approval on the live surface alone.
 *
 * What comes out is the three codes a refused publish already carries on the
 * wire, so the door, a screen and a merchant's own program name one missing
 * thing with one word. The codes are the contract's; this module imports only
 * their type, so the package keeps no runtime dependency (ADR-0003 §2).
 */

import type { MerchantFinding } from "@nuanu-ai/agentify-contracts";
import type { SurfaceMode } from "../deployment/environment.js";

/**
 * A fact the caller did not read.
 *
 * The cabinet reads no approval, since no route tells it whether a merchant
 * holds one, and a screen that did not ask the gateway for the wallet cannot
 * say anything about it. A symbol rather than `undefined`, so a caller cannot
 * leave a fact out by accident and have it read as unknown, and rather than a
 * word, since a seller could be named "unknown".
 */
export const UNKNOWN: unique symbol = Symbol("unknown");
export type Unknown = typeof UNKNOWN;

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

const ASKED: Readonly<Record<SurfaceMode, readonly MerchantFinding[]>> = {
  sandbox: ["no_seller_name"],
  test: ["no_seller_name", "no_payout_wallet"],
  live: ["no_seller_name", "no_payout_wallet", "no_operator_approval"],
};

const isSet = (value: string | null | Unknown): boolean | Unknown =>
  value === UNKNOWN ? UNKNOWN : value !== null;

/** What this merchant lacks on this surface, and what the caller could not tell. */
export function readinessOf(facts: MerchantFacts, surface: SurfaceMode): Readiness {
  // Keyed by every code there is, so a fourth one added to the contract does
  // not compile until somebody says which fact answers it.
  const held: Readonly<Record<MerchantFinding, boolean | Unknown>> = {
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
