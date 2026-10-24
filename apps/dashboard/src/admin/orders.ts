/**
 * The workspace's Orders, one order's page and the lookup that finds a record
 * by what an operator has in hand. Nothing here changes an order. A read that
 * fails is drawn as one that could not be read, never as an empty list.
 */

import { type Found, lookupOf, type OrdersPage } from "@agentify/gateway/operator";
import type { Outcome } from "../page-services.js";
import type { Operator } from "./access.js";
import type { SectionCounts } from "./frame.js";
import {
  type AccountFound,
  type FindView,
  findView,
  type OrderPageView,
  type OrdersListView,
  orderPageView,
  ordersAskedIn,
  ordersListView,
  typedIn,
} from "./orders-view.js";
import type { AdminParts } from "./parts.js";

export interface OrdersPages {
  list(operator: Operator, query: URLSearchParams): Promise<Outcome<OrdersListView>>;
  one(operator: Operator, orderId: string): Promise<Outcome<OrderPageView>>;
  /** The lookup: `q` as the box sends it. One match is a redirect to its record. */
  find(operator: Operator, query: URLSearchParams): Promise<Outcome<FindView>>;
  /** The Orders section's count in the sidebar: the payments whose outcome is unknown. */
  counts(operator: Operator): Promise<SectionCounts>;
}

/** How much of a pasted text the lookup reads. */
const LOOKUP_AT_MOST = 300;

const failed = (what: string) => {
  console.error(`[dashboard] the operator's ${what} could not be read`);
};

export function ordersFor(parts: AdminParts): OrdersPages {
  const reader = parts.reader.orders;

  /** The records a pasted text names, from the gateway, the identity and the shops. */
  async function lookedUp(q: string, at: Date): Promise<readonly (Found | AccountFound)[]> {
    if (lookupOf(q).kind === "email") {
      const account = await parts.identity.accountWithEmail(q);
      return account === null ? [] : [{ kind: "account", id: account.id, email: account.email }];
    }
    const found: (Found | AccountFound)[] = [...(await reader.find(q, at.getTime()))];
    const asked = lookupOf(q);
    if (asked.kind !== "site" || parts.shops === null) return found;
    // Only each shop's site and account are read here; its keys go no further.
    const accountIds = (await parts.shops.connections())
      .filter(({ shopUrl }) => {
        const site = lookupOf(shopUrl);
        return site.kind === "site" && site.origin === asked.origin;
      })
      .map(({ accountId }) => accountId);
    if (accountIds.length === 0) return found;
    for (const { merchantId } of await parts.identity.accountsNamed({ accountIds })) {
      if (merchantId === null) continue;
      if (found.some((one) => one.kind === "merchant" && one.merchant.id === merchantId)) continue;
      for (const named of await reader.find(merchantId, at.getTime())) {
        if (named.kind === "merchant") found.push({ ...named, by: "site" });
      }
    }
    return found;
  }

  return {
    async list(_operator, query) {
      const asked = ordersAskedIn(query);
      const readAt = parts.now();
      let page: OrdersPage | null;
      try {
        page = await reader.orders({
          shown: asked.shown,
          ...(asked.q === "" ? {} : { search: asked.q }),
          ...(asked.merchantId === null ? {} : { merchantId: asked.merchantId }),
          ...(asked.before === null ? {} : { before: asked.before }),
        });
      } catch {
        failed("orders");
        page = null;
      }
      return {
        kind: "view",
        view: ordersListView(asked, page, readAt),
        ...(page === null ? { status: 503 } : {}),
      };
    },

    async one(_operator, orderId) {
      const readAt = parts.now();
      let order: Awaited<ReturnType<typeof reader.order>> | "unread";
      try {
        // An identifier holding what no identifier holds names no order, and is not read.
        order = typedIn(orderId, 200) === orderId ? await reader.order(orderId) : null;
      } catch {
        failed("order");
        order = "unread";
      }
      const view = orderPageView(orderId, order, parts.config, readAt);
      return {
        kind: "view",
        view,
        ...(view.kind === "unread" ? { status: 503 } : {}),
      };
    },

    async find(_operator, query) {
      const q = typedIn(query.get("q"), LOOKUP_AT_MOST);
      let found: readonly (Found | AccountFound)[] | "unread" = [];
      if (q !== "") {
        try {
          found = await lookedUp(q, parts.now());
        } catch {
          failed("lookup");
          found = "unread";
        }
      }
      const view = findView(q, found, lookupOf(q).kind === "transaction");
      return view.kind === "open"
        ? { kind: "redirect", location: `${parts.config.basePath}${view.to}` }
        : { kind: "view", view, ...(view.kind === "unread" ? { status: 503 } : {}) };
    },

    async counts() {
      // The frame asks on every page, so one grouped count, not the list's page; it
      // counts with the same predicate as the Payment unknown segment.
      const unknown = await parts.reader.figures.unknownPayments({
        at: parts.now().getTime(),
        surface: parts.config.surfaceMode,
      });
      return { orders: { count: unknown.count, needsYou: false } };
    },
  };
}
