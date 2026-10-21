/**
 * The question "how much is this and is it there", and the merchant's answer.
 *
 * The question rides the same outgoing channel as the orders and is answered
 * by a price handler in the merchant's own process. A missing answer, a
 * timeout and an answer that does not parse are all the same to the gateway,
 * and what it does then depends on the card's mode.
 *
 * A price question carries no test marker, so a handler that routes test
 * orders to a test environment has nothing to route the question by.
 */

import { z } from "zod";
import { ParamNameSchema } from "./param-spec.js";
import { IdentifierSchema, MoneySchema, TimestampSchema } from "./primitives.js";
import { ShipToLocalitySchema } from "./ship-to.js";

/**
 * Why the price is being asked. `purchase` means an agent is buying right now;
 * `poll` means the gateway is refreshing what it knows and nobody is buying, so
 * an expensive stock lookup can be skipped.
 */
export const QuotePurposeSchema = z.enum(["purchase", "poll"]);

export const QuoteRequestSchema = z.strictObject({
  /** The merchant's own key for the product being asked about. */
  merchant_item_id: IdentifierSchema,

  /**
   * The purchase parameters, where the price depends on them. Absent for a
   * card that takes no input, and for a scheduled poll of such a card.
   */
  // The same key is dropped as everywhere this contract parses free-form names;
  // see `PROTOTYPE_KEY_IS_DROPPED` in `param-spec.ts`.
  params: z.record(ParamNameSchema, z.unknown()).optional(),

  /**
   * Where a parcel goes, as its price is asked: the country, the state, the
   * city and the postal code, and nothing about who receives it, since a price
   * question reaches a merchant for purchases never made. Present on a parcel's
   * question only. The answer is the whole price with shipping to this place
   * and any tax for it included, or not available where the merchant does not
   * ship there.
   */
  ship_to: ShipToLocalitySchema.optional(),

  /**
   * The identifier of this question, which comes back attached to the order.
   * It is good for one order: a merchant who set stock aside under it can
   * release it when the order arrives or when the price expires.
   */
  price_id: IdentifierSchema,

  purpose: QuotePurposeSchema,

  /**
   * Until when the price the merchant names will be honoured. There is no
   * separate message when it passes.
   */
  expires_at: TimestampSchema,
});

/**
 * The answer: available with a price, or not available. A price with `false`,
 * or `true` without a price, is refused.
 *
 * `as_of` is when the merchant's answer was true, separating "I went and
 * looked" from "here is what was in the cache". The gateway carries it into
 * the order and the record of the sale and does not weigh it: a price's life
 * runs from the moment the answer arrived, so an answer stamped a year ago is
 * honoured as long as one stamped a second ago.
 */
export const QuoteResponseSchema = z.discriminatedUnion("available", [
  z.strictObject({
    available: z.literal(true),
    price: MoneySchema.meta({
      description:
        'Held to the rule a card\'s price meets at publication: above zero, in USD or USDC, with two to six digits after the dot ("5.00", "0.001"); an answer that breaks it is refused and prices nothing.',
    }),
    as_of: TimestampSchema,
  }),
  z.strictObject({
    available: z.literal(false),
    as_of: TimestampSchema,
  }),
]);

export type QuotePurpose = z.infer<typeof QuotePurposeSchema>;
export type QuoteRequest = z.infer<typeof QuoteRequestSchema>;
export type QuoteResponse = z.infer<typeof QuoteResponseSchema>;
