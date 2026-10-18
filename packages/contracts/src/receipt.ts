/**
 * The receipt: the record left by a purchase that was paid for. A purchase that
 * ends before any payment leaves no receipt. The price on a receipt is the
 * price the sale went through at, and it stays so after the merchant's price
 * changes.
 *
 * The shape can describe a payment whose delivery is still running, but when
 * a receipt is written is the gateway's to decide, and Agentify's gateway
 * writes one only once the goods are delivered or the parcel has shipped.
 */

import { z } from "zod";
import { IdentifierSchema, SalePriceSchema, TimestampSchema } from "./primitives.js";

/**
 * What became of the purchase behind this receipt, in the order's own words.
 *
 * Only endings a paid purchase can reach appear here. `payment_unresolved` is
 * left out on purpose: it means nobody can say whether the buyer was charged,
 * and a receipt is the evidence that they were. No receipt is written while
 * that question is open; if the payment layer later answers that the money
 * moved, the receipt is written then. A charge an operator records by hand
 * gets none, because nothing here saw that payment.
 *
 * The list does not promise that a receipt exists for every payment that
 * executed. Agentify's gateway writes a receipt only on the way into delivery,
 * so in practice only `delivered` and `shipped` appear: a payment taken at
 * purchase whose goods have not come, and an order owing a refund, have no
 * receipt.
 */
export const ReceiptOutcomeSchema = z.enum([
  "in_progress",
  "delivered",
  "shipped",
  "refund_due",
  "refunded",
]);

export const ReceiptSchema = z.strictObject({
  /**
   * The receipt's own identifier. In the modes where the payment goes first,
   * this is what an agent repeats a purchase by.
   */
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
   * When the payment executed, which is neither of the moments in `price`: in
   * synchronous fulfillment the payment comes after the delivery, and an agent
   * may pay long after a price check fixed the price.
   */
  paid_at: TimestampSchema,

  outcome: ReceiptOutcomeSchema,

  /**
   * The buyer's payment as the payment layer reported it when the charge went
   * through — on an EVM chain, the hash of the transaction that paid the
   * merchant's payout contract — so a receipt can be matched to its payment on
   * the chain by more than its time. It is not a transfer into the merchant's
   * wallet, which receives one transfer per payout from the 0xSplits
   * warehouse, the shared contract a payout contract pays its shares through,
   * covering every sale paid in since the payout before. Absent when the
   * payment layer did not report one.
   */
  transaction: z.string().regex(/\S/, "a transaction names the transfer").optional(),

  /**
   * Whether this was a test purchase. An unmarked receipt for one would be
   * proof of a payment that never happened.
   */
  test: z.boolean(),
});

export type ReceiptOutcome = z.infer<typeof ReceiptOutcomeSchema>;
export type Receipt = z.infer<typeof ReceiptSchema>;
