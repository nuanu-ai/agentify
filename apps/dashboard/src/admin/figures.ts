/**
 * The workspace's Overview, Health and Money. Owned by the figures area, which
 * replaces the placeholders. Every figure is read when the page is asked for
 * and says when it was read; a read that fails says so, never a zero.
 */

import type { Outcome } from "../page-services.js";
import type { Operator } from "./access.js";
import type { SectionCounts } from "./frame.js";
import type { AdminParts } from "./parts.js";
import { type PlaceholderView, placeholder } from "./placeholder.js";

export interface FiguresPages {
  overview(operator: Operator, query: URLSearchParams): Promise<Outcome<PlaceholderView>>;
  health(operator: Operator): Promise<Outcome<PlaceholderView>>;
  money(operator: Operator, query: URLSearchParams): Promise<Outcome<PlaceholderView>>;
  /** The Overview's and Health's counts in the sidebar. */
  counts(operator: Operator): Promise<SectionCounts>;
}

export function figuresFor(_parts: AdminParts): FiguresPages {
  return {
    overview: () => placeholder("overview"),
    health: () => placeholder("health"),
    money: () => placeholder("money"),
    counts: async () => ({}),
  };
}
