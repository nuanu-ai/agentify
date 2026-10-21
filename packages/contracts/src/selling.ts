/**
 * Whether a merchant is taking new orders. A pause takes the cards off sale and
 * lets accepted orders play out.
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
] as const);

export const SellingStateSchema = z.enum(SELLING_STATES).meta({
  description:
    'Whether a merchant is taking new orders. "open" — new orders are taken. "paused" — no new order is taken and the orders already accepted play out in the ordinary way, so a pause never closes anything.',
});

export type SellingState = z.infer<typeof SellingStateSchema>;
