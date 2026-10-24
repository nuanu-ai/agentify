/**
 * The predicates the operator's figures and lists share, written once so a
 * count on the overview and the list it opens cannot disagree. Each is the
 * SQL twin of a function in `ports/operator/`, which the memory reader uses,
 * and each is wrapped in parentheses so it can stand inside any condition.
 */

import { sql } from "drizzle-orm";
import { ENDED_STATES, IN_PROGRESS_STATES } from "../../../ports/operator/orders.js";
import { orders } from "../schema.js";

/**
 * A payment whose outcome nobody has said yet, as `paymentUnknown` reads it.
 * Written exactly as the partial index `orders_unresolved_payment_idx` is, so
 * the planner reads it through that index.
 */
export const PAYMENT_UNKNOWN = sql`${orders.record} -> 'order' ->> 'payment' in ('settling', 'outcome_unknown')`;

/** A list of states written into the SQL itself, as constants of this file. */
const statesIn = (states: readonly string[]) =>
  sql.raw(`(${states.map((state) => `'${state}'`).join(", ")})`);

/** `unfulfilledOrder`. */
export const UNFULFILLED = sql`(${orders.state} = 'unfulfilled' and not (${PAYMENT_UNKNOWN}))`;

/** `deliveredNotPaid`. */
export const DELIVERED_NOT_PAID = sql`(${orders.state} = 'delivered_unpaid' and not (${PAYMENT_UNKNOWN}))`;

/** `inProgress`. */
export const IN_PROGRESS = sql`(${orders.state} in ${statesIn(IN_PROGRESS_STATES)} and not (${PAYMENT_UNKNOWN}))`;

/** `endedOrder`. */
export const ENDED = sql`(${orders.state} in ${statesIn(ENDED_STATES)} and not ${orders.lapsed} and not (${PAYMENT_UNKNOWN}))`;

/** `lapsedAttempt`, as the store writes it into the orders table's `lapsed` column. */
export const LAPSED = sql`(${orders.lapsed})`;
