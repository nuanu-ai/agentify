/**
 * An order read back, in the words this package can read. Agentify may be
 * newer than the package, so a status or a payment word the package was not
 * built with reads `unknown`: never one of the endings a merchant's code acts
 * on, and a sign that a newer package knows what it means.
 */

import type * as Contract from "@nuanu-ai/agentify-contracts";

/** Where an order stands, or `unknown` for a word this package does not know. */
export type OrderStatus = Contract.Read<Contract.OrderStatus>;

/** What became of the buyer's payment, or `unknown` for a word this package does not know. */
export type PaymentStatus = Contract.Read<Contract.PaymentStatus>;

/** An order with where it stands, as `orders.get` and `orders.list` read it. */
export type OrderWithStatus = Contract.Read<Contract.OrderWithStatus>;

/** The document `orders.list` reads its orders from. */
export type OrderList = Contract.Read<Contract.OrderList>;
