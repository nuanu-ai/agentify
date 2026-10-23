/**
 * The reads the workspace's Orders, one order's page and the lookup make
 * across merchants. Never handed out from here: a buyer's key or status
 * address, a parcel's address, purchase parameter values, delivered goods, or
 * a payer's wallet.
 */

import type { StoredOrder } from "../store.js";

// biome-ignore lint/suspicious/noEmptyInterface: the orders area adds its reads here.
export interface OperatorOrders {}

/**
 * A payment whose outcome nobody has said yet: a charge still settling, or one
 * whose answer was lost, as the agent's `unresolved` reads. The one predicate
 * the overview's count and the Payment unknown segment both use; on Postgres
 * it is `PAYMENT_UNKNOWN` in `adapters/postgres/operator/predicates.ts`, which
 * reads through the orders table's partial index for it.
 */
export const paymentUnknown = (record: StoredOrder): boolean =>
  record.order.payment === "settling" || record.order.payment === "outcome_unknown";
