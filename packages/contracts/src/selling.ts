/**
 * Whether a merchant is taking new orders.
 *
 * Three words rather than a boolean, because leaving is not a heavier pause. A
 * pause takes the cards off sale and lets accepted orders play out; leaving
 * stops those orders and records paid purchases without fulfillment, and it is not undone by resuming.
 */

import { z } from "zod";

export const SELLING_STATES = Object.freeze([
  /** Selling: new orders are taken. */
  "open",
  /**
   * Paused: no new order is taken, and the orders already accepted play out in
   * the ordinary way. Nothing about an open order changes when a pause begins.
   */
  "paused",
  /**
   * Gone: the merchant left. Their cards are off sale, the orders that were
   * open closed with them, and paid purchases without fulfillment are recorded as unfulfilled.
   */
  "departed",
] as const);

export const SellingStateSchema = z.enum(SELLING_STATES).meta({
  description:
    'Whether a merchant is taking new orders. "open" — new orders are taken. "paused" — no new order is taken and the orders already accepted play out in the ordinary way, so a pause never closes anything. "departed" — the merchant left, their cards are off sale, the orders that were open closed with them, and paid purchases without fulfillment are recorded as unfulfilled. Leaving is not a heavier pause: it is not reachable by pausing, and it is not undone by resuming.',
});

export type SellingState = z.infer<typeof SellingStateSchema>;
