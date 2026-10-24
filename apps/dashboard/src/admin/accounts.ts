/**
 * The workspace's Accounts, one account's actions (end every session, the
 * operator flag, on the test channel forgetting an account), and the Journal.
 * Owned by the accounts area, which replaces the placeholders.
 */

import type { Outcome } from "../page-services.js";
import type { Operator } from "./access.js";
import type { SectionCounts } from "./frame.js";
import type { AdminParts } from "./parts.js";
import { type PlaceholderView, placeholder } from "./placeholder.js";

export interface AccountsPages {
  list(operator: Operator, query: URLSearchParams): Promise<Outcome<PlaceholderView>>;
  one(operator: Operator, accountId: string): Promise<Outcome<PlaceholderView>>;
  journal(operator: Operator, query: URLSearchParams): Promise<Outcome<PlaceholderView>>;
  /** The Accounts and Journal sections' counts in the sidebar. */
  counts(operator: Operator): Promise<SectionCounts>;
}

export function accountsFor(_parts: AdminParts): AccountsPages {
  return {
    list: () => placeholder("accounts"),
    one: () => placeholder("accounts"),
    journal: () => placeholder("journal"),
    counts: async () => ({}),
  };
}
