/**
 * The workspace's Merchants and one merchant's page, and every action on a
 * merchant: admit, withdraw, take the listing name away, disable a key.
 * Owned by the merchants area, which replaces the placeholders.
 */

import type { Outcome } from "../page-services.js";
import type { Operator } from "./access.js";
import type { SectionCounts } from "./frame.js";
import type { AdminParts } from "./parts.js";
import { type PlaceholderView, placeholder } from "./placeholder.js";

export interface MerchantsPages {
  list(operator: Operator, query: URLSearchParams): Promise<Outcome<PlaceholderView>>;
  one(operator: Operator, merchantId: string): Promise<Outcome<PlaceholderView>>;
  /** The Merchants section's count in the sidebar. */
  counts(operator: Operator): Promise<SectionCounts>;
}

export function merchantsFor(_parts: AdminParts): MerchantsPages {
  return {
    list: () => placeholder("merchants"),
    one: () => placeholder("merchants"),
    counts: async () => ({}),
  };
}
