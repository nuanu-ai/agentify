/**
 * The order, as it reaches the merchant's handler.
 *
 * By the time an order exists the purchase has been checked: the card was
 * found, the parameters passed the card's own declaration, the price was
 * settled and the payment was verified. Invalid purchases, stale prices and
 * payments that did not verify never reach a handler.
 *
 * The order carries no state and no deadline. Its state is read back by a
 * separate call, in the words of `OrderStatusSchema`.
 */

import { z } from "zod";
import { ParamNameSchema } from "./param-spec.js";
import { IdentifierSchema, SalePriceSchema } from "./primitives.js";
import { ErasedShipToSchema, ShipToLocalitySchema, ShipToSchema } from "./ship-to.js";

export const OrderSchema = z.strictObject({
  /**
   * The order's identifier, which is also its idempotency key: the same string
   * on every redelivery. Delivery is at least once, so a handler must answer a
   * repeated identifier from what it already did rather than deliver twice.
   */
  id: IdentifierSchema,

  /** The merchant's own key for the product, the one their database uses. */
  merchant_item_id: IdentifierSchema,

  /**
   * The purchase parameters, already checked against the card's declaration.
   * Always present, and empty for a card that takes no input.
   */
  // One key is dropped here rather than carried or refused; the reason is at
  // `PROTOTYPE_KEY_IS_DROPPED` in `param-spec.ts`.
  params: z.record(ParamNameSchema, z.unknown()),

  /**
   * What the product was actually sold for, which is not always the card's
   * price: a card with a price check sells at the price the check answered.
   */
  price: SalePriceSchema,

  /**
   * The identifier of the price question this sale came out of, absent when no
   * question was asked. A merchant who set stock aside under this identifier
   * can release it here.
   */
  price_id: IdentifierSchema.optional(),

  /**
   * Where a parcel goes, present on a parcel's order only, in one of three
   * shapes as the order goes along. Before payment, the locality the price was
   * asked for and nothing about who receives it. Once paid, the whole address,
   * which the merchant stores before taking the order on. Once Agentify no
   * longer needs it (the order taken on, its shipment recorded, or the order
   * ended or unfulfilled without being taken on), only the moment Agentify
   * erased its copy from its database; from then on the merchant has the
   * address only as they stored it, and the order is not handed to a handler
   * again. Backups of the live channel taken before the erasure keep the
   * address until they expire, most of it about sixty days later, with no
   * upper bound set yet for all of it.
   */
  ship_to: z.union([ShipToSchema, ShipToLocalitySchema, ErasedShipToSchema]).optional(),

  /**
   * Whether this is a test order. Required rather than defaulted: a test order
   * taken for a live one is a real delivery made against money that does not
   * exist.
   */
  test: z.boolean(),
});

export type Order = z.infer<typeof OrderSchema>;
