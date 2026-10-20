/**
 * What the merchant's calls hand back, successes and failures alike, as values
 * rather than exceptions. The words below are wire names a merchant's code
 * branches on.
 *
 * Every answer arrives in one envelope: `ok` is `true` or `false`, a success
 * carries its own fields beside it, and a failure carries `error`. `ok` is a
 * literal rather than a key that may be absent, because `{"ok": {}}` is falsy
 * in Python and PHP, and as a literal it is a discriminator a generated client
 * can switch on.
 *
 * `error` is why a call did not go through: one object with a code, a sentence
 * and whether repeating could change the outcome. `problems` is the list of
 * findings about what was sent, and rides inside `error` wherever there are
 * any.
 */

import { z } from "zod";
import { IdentifierSchema } from "./primitives.js";

/**
 * How answering for an order can succeed. Each word is a different next step
 * for the merchant.
 *
 * `accepted`: a handler took the order on, and the goods will follow through
 * `deliver`. `delivered`: the sale closed. `already_delivered`: a retry landed
 * twice; nothing is delivered or charged twice, so treat it as success, not as
 * a failure because it is not `delivered`. `delivered_late`: the
 * delivery deadline had passed and the goods went out anyway. `refused`: the refusal took effect.
 * `purchase_already_closed`: a synchronous handler answered after its
 * deadline; the work exists and a repeat purchase will collect it.
 *
 * Branch on `ok` and record the word. A client that checks answers against its
 * own copy of this schema, as the SDK does, reads a word it does not know as an
 * unreadable answer. From the first external merchant, such a change moves
 * `CONTRACT_VERSION` so an older worker stops at its version check. During
 * the pilot, keep workers current with the gateway.
 */
export const ORDER_CALL_RESULTS = Object.freeze([
  "accepted",
  "delivered",
  "already_delivered",
  "delivered_late",
  "refused",
  "purchase_already_closed",
] as const);

export const OrderCallResultSchema = z.enum(ORDER_CALL_RESULTS);

/**
 * The error codes the order calls answer with. The code on the wire stays an
 * open string, so an unanticipated error reaches the merchant in its own words.
 *
 * `fulfillment_closed`: the merchant closed future fulfillment through Agentify.
 * `order_already_closed`: this order reached an ending that this call cannot
 * change. `not_applicable_in_mode`: this mode has no such call or answer.
 * `shipment_already_recorded`: a different shipment is already recorded;
 * repeating the same shipment succeeds without changing it.
 *
 * `delivery_does_not_match_card`: the goods are not what the order was sold
 * with, nothing was written down, and `problems` names the fields that did not
 * fit. It is retryable while the order is open, but not in the sense of a lost
 * connection: the same goods get the same refusal until they change. On an
 * order that has already ended it is not retryable, and the message says so.
 */
export const ORDER_CALL_ERROR_CODES = Object.freeze([
  "fulfillment_closed",
  "order_already_closed",
  "not_applicable_in_mode",
  "delivery_does_not_match_card",
  "shipment_already_recorded",
] as const);

/**
 * One thing wrong with what was sent: where, a code and the words. Findings
 * travel as a list under `problems` inside the error of a call that refused
 * what it was handed. `checkCard` in the SDK answers in this same shape.
 */
export const ProblemSchema = z
  .strictObject({
    /**
     * The path to the field the finding is about, as `["params", "email",
     * "type"]`. An empty path is a statement, not a missing value: the finding
     * is about the whole of what was sent, or about the merchant (no name set
     * for buyers, no payout wallet, no operator approval for the live catalog).
     */
    path: z.array(z.string()),

    /**
     * What kind of finding it is, for the code that reads it. Open, except the
     * findings about the merchant in `MERCHANT_FINDINGS`, which are promised.
     */
    code: z.string().regex(/\S/, "a finding carries a code").meta({
      description:
        'What kind of finding it is, for the program that reads it. The set is open: a finding about a field of what was sent carries the name the check gave it. Four are promised, always with an empty path, and each says the merchant rather than the card is missing something, so no edit to the card clears it: "no_seller_name" (no name set for buyers to read), "no_payout_wallet" (no wallet set for the merchant\'s share of sales to arrive at, asked for wherever a payment settles), "no_operator_approval" (the operator has not admitted this merchant to the live catalog, which only the operator can change) and "no_seller_site" (no site set for the merchant\'s shop, asked for on a parcel\'s card alone, because a parcel that does not arrive is a question its buyer takes there).',
    }),

    /** The same finding in words, for the person who has to fix the card. */
    message: z.string().regex(/\S/, "a finding carries an explanation a person can read"),
  })
  .meta({
    description:
      'One thing wrong with what was sent: where it is, a code for the program that reads it, and the same finding in words for the person who has to fix it. The path names the field, innermost last — ["params", "email", "type"] — and an empty path is a statement rather than a missing value: the finding is about the whole of what was sent, or about the sender — a merchant with no name set for buyers, no wallet set for their sales to be paid into, or no operator approval for the live catalogue is refused with an empty path too — and not about any one field, which is also what a document that could not be read at all produces. The field is always present for that reason, because an absent path and an empty one would be indistinguishable. Findings never travel alone: they arrive as the problems list inside the error of a call that refused what it was handed — a card that was not published, a delivery that is not what its card declares, a body or a set of purchase parameters that did not fit.',
  });

/**
 * Why a call did not go through: a code to branch on, a sentence to print, and
 * whether repeating the call could change the outcome. One shape for every
 * call on the merchant's surface.
 *
 * `retryable` is required: `true` means sending the call again could change
 * the outcome, and `false` means it cannot, so the case is one to write down.
 *
 * `problems` is present where the call refuses what it was handed, and never
 * empty when present. It is absent where the failure is about the state of the
 * world, such as fulfillment already closed.
 */
export const CallErrorSchema = z.strictObject({
  code: z.string().regex(/\S/, "an error carries a code").meta({
    // The promised codes travel in the description, so that a client generated
    // from the JSON Schema export learns them.
    description:
      "Why the call did not go through. Codes are open strings. card_rejected means publication failed and error.problems names every finding, including the merchant's missing name, payout wallet, live approval or parcel shop site. Order calls promise fulfillment_closed (the merchant stopped future Agentify fulfillment), order_already_closed (the call cannot change the order's ending), not_applicable_in_mode (the mode has no such call or answer), delivery_does_not_match_card (the goods do not match the card sold with the order; problems names the fields, and retryable is true only while delivery can still be corrected), and shipment_already_recorded (a different shipment is recorded and cannot be replaced; repeating the same one succeeds). No code establishes a refund or settlement.",
  }),
  message: z.string().regex(/\S/, "an error carries an explanation a person can read"),
  retryable: z.boolean(),

  /**
   * The findings, where the call refuses what it was handed. Never empty when
   * present, and the complete account: the error's `message` is a single line
   * for a log and does not carry the list.
   */
  problems: z.array(ProblemSchema).min(1).optional().meta({
    description:
      "What was wrong with what was sent, one finding at a time: where it is, a code for the program that reads it, and the same finding in words. Present where the call is refusing what it was handed — a card that was not published, a delivery that is not what its card declares — and absent where the refusal is about a state of the world instead: fulfillment already closed is about the order, not about a field of the request. Never empty where it is present, and a refused publish always carries it. This field is the complete account of what stands in the way, and it is the one to read the findings from. The error's \"message\" is a single line written to be read in a log and does not carry the list. Where what stands in the way is the merchant's own — no seller name, no payout wallet, no operator approval — the message names each of those plainly; for the rest it says how many findings there are, quotes one of them, and marks the place where a long one was cut — so a reader can always tell a short refusal from a shortened account of a long one.",
  }),
});

/** The code a refused publish comes back under. */
export const CARD_REJECTED = "card_rejected";

/**
 * The findings of a refused publish that are about the merchant rather than
 * the card, each with an empty path, and none cleared by editing the card.
 *
 * `no_seller_name`: no name for buyers to read, set with `POST /v0/seller-name`
 * or in the dashboard. `no_payout_wallet`: no wallet for the merchant's
 * share of sales to arrive at, set only in the dashboard's Settings, since no
 * key of the merchant's code may say where the money goes.
 * `no_operator_approval`: the operator has not admitted the merchant to the
 * live catalog, which only the operator can change. `no_seller_site`: on a
 * parcel's card only, no site for the merchant's shop, set where the name is.
 */
export const MERCHANT_FINDINGS = Object.freeze({
  NO_SELLER_NAME: "no_seller_name",
  NO_PAYOUT_WALLET: "no_payout_wallet",
  NO_OPERATOR_APPROVAL: "no_operator_approval",
  NO_SELLER_SITE: "no_seller_site",
} as const);

/** One of the findings about the merchant, as its code travels on the wire. */
export type MerchantFinding = (typeof MERCHANT_FINDINGS)[keyof typeof MERCHANT_FINDINGS];

/**
 * The error a refused publish carries: the shared shape with `problems`
 * required, so one answer names everything standing between the card and the
 * catalog, the merchant's own missing settings included.
 */
const PublishRefusalSchema = CallErrorSchema.extend({
  problems: z.array(ProblemSchema).min(1),
});

/**
 * The answer to publishing a card: the catalog identifier, or what stands in
 * its way. A refusal is `CARD_REJECTED` and never retryable: the same card gets
 * the same answer until what the findings name is fixed.
 */
export const PublishResultSchema = z.discriminatedUnion("ok", [
  z.strictObject({
    ok: z.literal(true),

    /** The catalog identifier, used from now on in catalogs, orders and receipts. */
    id: IdentifierSchema,
  }),
  z.strictObject({ ok: z.literal(false), error: PublishRefusalSchema }),
]);

export type Problem = z.infer<typeof ProblemSchema>;
export type PublishResult = z.infer<typeof PublishResultSchema>;
export type OrderCallResult = z.infer<typeof OrderCallResultSchema>;
export type CallError = z.infer<typeof CallErrorSchema>;
