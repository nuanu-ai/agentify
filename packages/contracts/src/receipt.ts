/**
 * The receipt records a paid sale. Agentify's gateway writes one when payment
 * is confirmed and the goods are released or a parcel's shipment is recorded.
 * A purchase that ends before payment, an unknown payment and a paid order
 * still awaiting fulfillment have no receipt. The sale price stays unchanged
 * after the merchant changes their price.
 *
 * Its outcome remains the issuance fact when later fulfillment is closed.
 */

import { z } from "zod";
import { IdentifierSchema, SalePriceSchema, TimestampSchema } from "./primitives.js";

/**
 * What became of the purchase behind this receipt, in the order's own words.
 *
 * `payment_unresolved` is absent because a receipt cannot claim payment while
 * its outcome is unknown. A late facilitator confirmation or verified chain
 * evidence can release goods already held and write their receipt unless the
 * merchant has closed future Agentify fulfillment. An
 * unverified assertion of payment cannot supply that evidence.
 *
 * The list does not promise that a receipt exists for every payment that
 * executed. Agentify's gateway issues only `delivered` and `shipped` receipts:
 * a prepaid order still awaiting fulfillment, including one whose late payment
 * leaves fulfillment incomplete, has no receipt.
 */
export const ReceiptOutcomeSchema = z.enum([
  "in_progress",
  "delivered",
  "shipped",
  "unfulfilled",
  "fulfillment_closed",
]);

export const ReceiptSchema = z.strictObject({
  /** The receipt's own identifier; `order_id` identifies the purchase. */
  id: IdentifierSchema,

  /** The order this purchase produced. */
  order_id: IdentifierSchema,

  /** Our catalog identifier for the card that was bought. */
  item_id: IdentifierSchema,

  /** The price the sale went through at, with the moment behind it. */
  price: SalePriceSchema,

  /** The price question the sale came out of, absent when there was none. */
  price_id: IdentifierSchema.optional(),

  /**
   * The facilitator's payment confirmation time, or the transaction block's
   * execution time for a chain-recovered payment. It is neither of the moments
   * in `price`, nor the later moment when recovery found the payment.
   */
  paid_at: TimestampSchema,

  outcome: ReceiptOutcomeSchema,

  /**
   * The buyer's payment as reported by the facilitator or verified from chain
   * evidence — on an EVM chain, the hash of the transaction that paid the
   * merchant's payout contract — so a receipt can be matched to its payment on
   * the chain by more than its time. It is not a transfer into the merchant's
   * wallet, which receives one transfer per payout from the 0xSplits
   * warehouse, the shared contract a payout contract pays its shares through,
   * covering every sale paid in since the payout before. Absent when no
   * transaction was recorded.
   */
  transaction: z.string().regex(/\S/, "a transaction names the transfer").optional(),

  /**
   * Whether this was a test purchase. A test receipt is not proof that real
   * money moved.
   */
  test: z.boolean(),
});

export type ReceiptOutcome = z.infer<typeof ReceiptOutcomeSchema>;
export type Receipt = z.infer<typeof ReceiptSchema>;
