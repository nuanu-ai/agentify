/**
 * The operator's Orders, one order's page and the lookup, over HTTP against a
 * real gateway's real purchase, and with readers that fail or shops that sell
 * from a site. If these fail, an operator reads an order differently from the
 * agent or the merchant, is told "none" where nothing could be read, or a
 * buyer's key reaches a page.
 */

import type { OperatorOrders, OperatorReader } from "@agentify/gateway/operator";
import { buyOverHttp, serve, theMerchantKey } from "@agentify/gateway/testing";
import type { Card } from "@nuanu-ai/agentify-contracts";
import { afterEach, describe, expect, it } from "vitest";
import type { DashboardIdentity, NamedAccount } from "../dashboard-entry.js";
import { type AdminServed, adminServed } from "../testing/admin.js";
import { readable } from "../testing/html.js";
import type { WooShops } from "../woo-shops.js";
import type { Operator } from "./access.js";
import { ordersFor } from "./orders.js";
import { EXAMPLE_MERCHANT, READ_AT } from "./orders-fixtures.js";
import type { AdminParts } from "./parts.js";

const OPERATOR = "operator@example.com";

const roomCard: Card = {
  merchant_item_id: "room-101",
  title: "A room for the night",
  description: "One night in room 101",
  price: { amount: "80.00", currency: "USD" },
  result: { access_code: { type: "string" } },
  fulfillment: "sync",
};

let opened: AdminServed | null = null;
let gatewayServed: Awaited<ReturnType<typeof serve>> | null = null;

afterEach(async () => {
  await gatewayServed?.close();
  await opened?.close();
  opened = null;
  gatewayServed = null;
});

/** The workspace with one delivered purchase made through the gateway's own routes. */
async function withAPurchase() {
  opened = await adminServed();
  const { harnessed } = opened;
  gatewayServed = await serve(harnessed);
  const published = await gatewayServed.call("POST", "/v0/catalog/publish", {
    body: roomCard,
    headers: { authorization: `Bearer ${theMerchantKey("test")}` },
  });
  const itemId = (published.body as { id: string }).id;
  const bought = await buyOverHttp(harnessed, gatewayServed, itemId, {
    onOrder: () => ({ delivered: { access_code: "SESAME-4711" } }),
  });
  const body = bought.body as { order_id: string; status_url: string };
  const browser = await opened.signedIn(OPERATOR, { operator: true });
  return { browser, orderId: body.order_id, buyerKey: body.status_url.split("/").at(-2) ?? "" };
}

describe("the orders over HTTP", () => {
  it("lists a real purchase in the merchant's words, and opens its page with the agent's beside them", async () => {
    const { browser, orderId, buyerKey } = await withAPurchase();

    const list = await browser.get("/admin/orders");
    const listed = readable(list.html);
    expect(list.status).toBe(200);
    expect(listed).toContain("A room for the night");
    expect(listed).toContain("80.00 USD");
    expect(listed).toContain("Delivered");
    expect(listed).toContain("Showing 1–1 of 1, newest first.");

    const one = await browser.get(`/admin/orders/${orderId}`);
    const page = readable(one.html);
    expect(one.status).toBe(200);
    expect(page).toContain("status: delivered");
    expect(page).toContain("payment_status: paid");
    expect(page).toContain("time not recorded");
    expect(page).toContain("Agentify does not change an order's outcome from here.");

    for (const html of [list.html, one.html]) {
      expect(html).not.toContain(`/${buyerKey}/`);
      expect(html).not.toContain("SESAME-4711");
    }
  });

  it("answers an order the channel does not hold with a page saying so, in the frame", async () => {
    const { browser } = await withAPurchase();

    const none = await browser.get("/admin/orders/ord_nothing_here");
    expect(none.status).toBe(200);
    expect(readable(none.html)).toContain("There is no order");
  });

  it("goes from a pasted order identifier straight to the order, and from an address to its account", async () => {
    const { browser, orderId } = await withAPurchase();

    const byId = await browser.get(`/admin/find?q=${encodeURIComponent(` ${orderId} `)}`);
    expect(byId.status).toBe(303);
    expect(byId.to).toBe(`/dashboard/admin/orders/${orderId}`);

    const person = await opened?.identity.byEmail(OPERATOR);
    const byEmail = await browser.get(
      `/admin/find?q=${encodeURIComponent("OPERATOR@example.com")}`,
    );
    expect(byEmail.to).toBe(`/dashboard/admin/accounts/${person?.id}`);
  });

  it("says a text names nothing, keeping what was pasted in the box", async () => {
    const { browser } = await withAPurchase();

    const none = await browser.get("/admin/find?q=ord_nothing_here");
    expect(none.status).toBe(200);
    expect(readable(none.html)).toContain("Nothing on this channel matches “ord_nothing_here”.");
    expect(none.html).toMatch(/name="q"[^>]*value="ord_nothing_here"/);
  });
});

/** The parts the orders area reads, with a reader, an identity and shops of the test's own. */
const partsWith = (
  reader: Partial<OperatorOrders>,
  people: Readonly<Record<string, NamedAccount>> = {},
  shops: readonly Readonly<{ accountId: string; shopUrl: string }>[] | null = null,
): AdminParts =>
  ({
    config: {
      basePath: "/dashboard",
      transactionPage: null,
      addressPage: null,
    },
    reader: { orders: reader as OperatorOrders } as OperatorReader,
    identity: {
      accountWithEmail: async (email: string) =>
        Object.values(people).find((one) => one.email === email) ?? null,
      accountsNamed: async ({ accountIds = [] }: { accountIds?: readonly string[] }) =>
        accountIds.flatMap((id) => (people[id] === undefined ? [] : [people[id]])),
    } as unknown as DashboardIdentity,
    shops: shops === null ? null : ({ connections: async () => shops } as unknown as WooShops),
    now: () => READ_AT,
  }) as unknown as AdminParts;

const OP = {} as Operator;
const failing = async () => {
  throw new Error("the database is not answering");
};

describe("a read of the orders that fails", () => {
  it("is drawn as could not be read on the list, the order and the lookup, never as none", async () => {
    const orders = ordersFor(partsWith({ orders: failing, order: failing, find: failing }));

    expect(await orders.list(OP, new URLSearchParams())).toMatchObject({
      kind: "view",
      view: { result: { kind: "unread" } },
    });
    expect(await orders.one(OP, "ord_a")).toMatchObject({
      status: 503,
      view: { kind: "unread", id: "ord_a" },
    });
    expect(await orders.find(OP, new URLSearchParams({ q: "ord_a" }))).toMatchObject({
      status: 503,
      view: { kind: "unread", q: "ord_a" },
    });
    await expect(orders.counts(OP)).rejects.toThrow();
  });
});

describe("an order identifier no order can have", () => {
  it("is answered as no such order without being read", async () => {
    const orders = ordersFor(partsWith({ order: failing }));

    expect(await orders.one(OP, "ord_a\u0000")).toMatchObject({ view: { kind: "none" } });
  });
});

describe("the lookup's halves the dashboard holds", () => {
  const owner: NamedAccount = {
    id: "acc_owner",
    email: "owner@example.com",
    merchantId: EXAMPLE_MERCHANT.id,
  };
  const reader = {
    find: async (text: string) =>
      text === EXAMPLE_MERCHANT.id
        ? [{ kind: "merchant" as const, by: "id" as const, merchant: EXAMPLE_MERCHANT }]
        : [],
  };

  it("goes from a WooCommerce shop's site to the merchant whose account connected it", async () => {
    const orders = ordersFor(
      partsWith(reader, { acc_owner: owner }, [
        { accountId: "acc_owner", shopUrl: "https://Shop.example" },
      ]),
    );

    expect(
      await orders.find(OP, new URLSearchParams({ q: "shop.example/product/x" })),
    ).toStrictEqual({
      kind: "redirect",
      location: `/dashboard/admin/merchants/${EXAMPLE_MERCHANT.id}`,
    });
  });

  it("finds nothing from a shop whose account made no merchant, nor from an address nobody signed in with", async () => {
    const orders = ordersFor(
      partsWith(reader, { acc_lone: { ...owner, id: "acc_lone", merchantId: null } }, [
        { accountId: "acc_lone", shopUrl: "https://shop.example" },
      ]),
    );

    expect(await orders.find(OP, new URLSearchParams({ q: "shop.example" }))).toMatchObject({
      view: { kind: "none" },
    });
    expect(await orders.find(OP, new URLSearchParams({ q: "nobody@example.com" }))).toMatchObject({
      view: { kind: "none", q: "nobody@example.com" },
    });
  });
});
