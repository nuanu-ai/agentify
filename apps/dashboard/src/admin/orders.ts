/**
 * The workspace's Orders, one order's page and the lookup that finds a record
 * by what an operator has in hand. Owned by the orders area, which replaces the
 * placeholders. Nothing here changes an order.
 */

import type { Outcome } from "../page-services.js";
import type { Operator } from "./access.js";
import type { SectionCounts } from "./frame.js";
import type { AdminParts } from "./parts.js";
import { type PlaceholderView, placeholder } from "./placeholder.js";

export interface OrdersPages {
  list(operator: Operator, query: URLSearchParams): Promise<Outcome<PlaceholderView>>;
  one(operator: Operator, orderId: string): Promise<Outcome<PlaceholderView>>;
  /** The lookup: `q` as the box sends it. */
  find(operator: Operator, query: URLSearchParams): Promise<Outcome<PlaceholderView>>;
  /** The Orders section's count in the sidebar. */
  counts(operator: Operator): Promise<SectionCounts>;
}

export function ordersFor(_parts: AdminParts): OrdersPages {
  return {
    list: () => placeholder("orders"),
    one: () => placeholder("orders"),
    find: () => placeholder("orders"),
    counts: async () => ({}),
  };
}
