/**
 * The predicates the operator's figures and lists share, written once so a
 * count on the overview and the list it opens cannot disagree. Each is the
 * SQL twin of a function in `ports/operator/`, which the memory reader uses.
 */

import { sql } from "drizzle-orm";
import { orders } from "../schema.js";

/**
 * A payment whose outcome nobody has said yet, as `paymentUnknown` reads it.
 * Written exactly as the partial index `orders_unresolved_payment_idx` is, so
 * the planner reads it through that index.
 */
export const PAYMENT_UNKNOWN = sql`${orders.record} -> 'order' ->> 'payment' in ('settling', 'outcome_unknown')`;
