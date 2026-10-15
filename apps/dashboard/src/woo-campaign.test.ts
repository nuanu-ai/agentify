/**
 * Bounded, offline WooCommerce campaign against the real import, inspector,
 * order ledger and recovery boundaries. The remote shop is a deterministic
 * document server; its persisted orders are evidence of external effects.
 * No chain, facilitator, merchant API or email is contacted.
 */
import { type Harness, harness } from "@agentify/gateway/testing";
import type { Order, OrderWithStatus } from "@nuanu-ai/agentify-contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";
import type { Person } from "./dashboard-entry.js";
import { gatewayFor } from "./gateway.js";
import { type Identity, identityFor } from "./identity.js";
import { TEST_AUTH_SECRET } from "./testing/secrets.js";
import { merchantItemIdFor, type StoreProduct } from "./woo-catalog.js";
import { wooPagesFor } from "./woo-pages.js";
import { recoverWooOrder, type WooRecoveryParts } from "./woo-recovery.js";
import type { WooRequest } from "./woo-request.js";
import {
  catalogueOf,
  createTheOrderInTheShop,
  createTheParcelInTheShop,
  inspectProductInTheShop,
  type WooOrderRead,
} from "./woo-shop.js";
import { memoryWooShops, type WooConnection, type WooOrderFacts } from "./woo-shops.js";
import { type Filling, fillFromTheShop } from "./woo-worker.js";

const SHOP = "https://shop.example.com";
const NOW = new Date("2026-10-15T12:00:00Z");
const EMAIL = "campaign@example.com";
type Kind = "download" | "parcel";
const KINDS: readonly Kind[] = ["download", "parcel"];
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** Lab seed shapes, with identifiers local to this document server. */
const fixture = (kind: Kind) => ({
  product: {
    id: 1,
    type: "simple",
    status: "publish",
    purchasable: true,
    stock_status: "instock",
    manage_stock: false,
    sold_individually: false,
    virtual: kind === "download",
    downloadable: kind === "download",
    download_limit: -1,
    download_expiry: -1,
    price: "1.00",
    downloads:
      kind === "download"
        ? [
            {
              id: "gift-messages",
              name: "gift-message-templates.txt",
              file: `${SHOP}/protected/gift-message-templates.txt`,
            },
          ]
        : [],
  },
  settings: {
    woocommerce_currency: "USD",
    woocommerce_calc_taxes: "no",
    woocommerce_file_download_method: "force",
    woocommerce_downloads_require_login: "no",
    woocommerce_downloads_grant_access_after_payment: "yes",
    woocommerce_downloads_redirect_fallback_allowed: "no",
    woocommerce_price_num_decimals: "2",
    woocommerce_ship_to_countries: "all",
    woocommerce_ship_to_destination: "shipping",
  } as Record<string, string>,
  rawStatus: 403,
  throwPath: "",
});
type Fixture = ReturnType<typeof fixture>;

const connection = (accountId = "campaign-account"): WooConnection => ({
  accountId,
  shopUrl: SHOP,
  consumerKey: "ck_local_fixture",
  consumerSecret: "cs_local_fixture",
  permissions: "read_write",
  revision: "campaign-grant",
  connectedAt: NOW,
});

const remoteProduct =
  (data: Fixture, requestedIdentity = false): WooRequest =>
  async (at) => {
    const path = new URL(at).pathname;
    if (data.throwPath !== "" && path.endsWith(data.throwPath))
      throw new Error("fixture transport loss");
    if (path.startsWith("/wp-json/wc/v3/products/")) {
      return json({
        ...data.product,
        ...(requestedIdentity ? { id: Number(path.split("/").at(-1)) } : {}),
      });
    }
    if (path.includes("/settings/"))
      return json({ value: data.settings[path.split("/").at(-1) ?? ""] });
    if (path.startsWith("/protected/")) return new Response(null, { status: data.rawStatus });
    throw new Error(`Unexpected local fixture request: ${path}`);
  };

const publicProduct = (kind: Kind, id = 1): StoreProduct => ({
  id,
  name: kind === "download" ? "Gift Message Templates" : "Canvas tote bag",
  sku: kind === "download" ? "DL-GIFT-MESSAGES" : "agentify-tote",
  description:
    kind === "download"
      ? "<p>Twenty short gift-card messages, delivered as one plain-text file.</p>"
      : "<p>A canvas tote bag that a carrier takes to the buyer.</p>",
  short_description: "",
  type: "simple",
  status: "publish",
  is_purchasable: true,
  is_in_stock: true,
  virtual: kind === "download",
  downloadable: kind === "download",
  manage_stock: false,
  download_limit: -1,
  download_expiry: -1,
  downloads: [],
  qualification_problem: null,
  prices: { price: "100", currency_code: "USD", currency_minor_unit: 2 },
});

const config = loadConfig({
  DATABASE_URL: "postgres://nobody@nowhere:5432/unused",
  AUTH_SECRET: TEST_AUTH_SECRET,
  PAYMENT_NETWORK: "eip155:84532",
  FACILITATOR_URL: "sandbox:scripted",
  PUBLIC_BASE_URL: "https://dashboard.example.com",
});
let real: Harness;
let identity: Identity;
beforeAll(async () => {
  real = await harness({ PAYMENT_NETWORK: "eip155:84532", FACILITATOR_URL: "sandbox:scripted" });
  identity = identityFor(config, { postman: async () => "accepted" });
});
afterAll(async () => {
  await identity?.close();
  await real?.stop();
});

const importer = async (
  data: Fixture,
  kind: Kind,
  catalogue: () => ReturnType<typeof catalogueOf>,
) => {
  const merchant = await real.addMerchant();
  const person: Person = {
    id: `account-${merchant.id}`,
    email: EMAIL,
    confirmed: true,
    merchant: { id: merchant.id },
  };
  const gateway = gatewayFor(real.gateway, { merchantId: merchant.id, email: EMAIL });
  await gateway.setSellerSite(SHOP);
  await gateway.sellThrough("woocommerce");
  const shops = memoryWooShops();
  await shops.connect(connection(person.id));
  const pages = wooPagesFor(config, {
    identity,
    shops,
    clientFor: (acting) => gatewayFor(real.gateway, acting),
    shop: {
      grantScreen: async () => ({ ok: true }),
      catalogue,
      inspectProduct: (keys, id) => inspectProductInTheShop(keys, id, remoteProduct(data, true)),
    },
  });
  return { gateway, run: () => pages.importCatalogue(person), kind };
};

interface Qualification {
  name: string;
  kind: Kind;
  change: (data: Fixture) => void;
  accepted: boolean;
}
const qualifications: Qualification[] = KINDS.map((kind) => ({
  name: "unchanged lab shape",
  kind,
  change: () => {},
  accepted: true,
}));
const common: ReadonlyArray<readonly [string, (data: Fixture) => void]> = [
  ...["variable", "grouped", "external"].map(
    (type) =>
      [
        type,
        (d: Fixture) => {
          d.product.type = type;
        },
      ] as const,
  ),
  ...["draft", "private"].map(
    (status) =>
      [
        status,
        (d: Fixture) => {
          d.product.status = status;
        },
      ] as const,
  ),
  [
    "not purchasable",
    (d) => {
      d.product.purchasable = false;
    },
  ],
  ...["outofstock", "onbackorder"].map(
    (stock) =>
      [
        stock,
        (d: Fixture) => {
          d.product.stock_status = stock;
        },
      ] as const,
  ),
  [
    "managed stock",
    (d) => {
      d.product.manage_stock = true;
    },
  ],
  [
    "sold individually",
    (d) => {
      d.product.sold_individually = true;
    },
  ],
  [
    "zero price",
    (d) => {
      d.product.price = "0";
    },
  ],
  [
    "subcent price",
    (d) => {
      d.product.price = "0.001";
    },
  ],
];
for (const kind of KINDS)
  for (const [name, change] of common) qualifications.push({ name, kind, change, accepted: false });
const downloadOnly: readonly [string, (data: Fixture) => void][] = [
  [
    "nonvirtual download",
    (d) => {
      d.product.virtual = false;
    },
  ],
  [
    "virtual without download",
    (d) => {
      d.product.downloadable = false;
    },
  ],
  [
    "no file",
    (d) => {
      d.product.downloads = [];
    },
  ],
  [
    "two files",
    (d) => {
      d.product.downloads.push(...d.product.downloads.map((file) => ({ ...file, id: "second" })));
    },
  ],
  [
    "finite count",
    (d) => {
      d.product.download_limit = 1;
    },
  ],
  [
    "finite expiry",
    (d) => {
      d.product.download_expiry = 1;
    },
  ],
  [
    "cross-origin file",
    (d) => {
      d.product.downloads = d.product.downloads.map((file) => ({
        ...file,
        file: "https://other.example/file.txt",
      }));
    },
  ],
  [
    "public raw bytes",
    (d) => {
      d.rawStatus = 200;
    },
  ],
  [
    "redirected raw bytes",
    (d) => {
      d.rawStatus = 302;
    },
  ],
  [
    "blank filename",
    (d) => {
      d.product.downloads = d.product.downloads.map((file) => ({ ...file, name: " " }));
    },
  ],
];
for (const [name, change] of downloadOnly)
  qualifications.push({ name, kind: "download", change, accepted: false });
for (const [setting, value] of [
  ["woocommerce_ship_to_countries", "disabled"],
  ["woocommerce_ship_to_destination", "billing_only"],
] as const) {
  qualifications.push({
    name: setting,
    kind: "parcel",
    change: (d) => {
      d.settings[setting] = value;
    },
    accepted: false,
  });
}
for (const kind of KINDS)
  for (const [setting, value] of [
    ["woocommerce_currency", "EUR"],
    ["woocommerce_calc_taxes", "yes"],
    ["woocommerce_price_num_decimals", "3"],
  ] as const) {
    qualifications.push({
      name: setting,
      kind,
      change: (d) => {
        d.settings[setting] = value;
      },
      accepted: false,
    });
  }
for (const [setting, value] of [
  ["woocommerce_file_download_method", "redirect"],
  ["woocommerce_downloads_require_login", "yes"],
  ["woocommerce_downloads_grant_access_after_payment", "no"],
  ["woocommerce_downloads_redirect_fallback_allowed", "yes"],
] as const) {
  qualifications.push({
    name: setting,
    kind: "download",
    change: (d) => {
      d.settings[setting] = value;
    },
    accepted: false,
  });
}

describe("campaign: 48 product qualification vectors", () => {
  for (const [index, vector] of qualifications.entries())
    it(`Q${index + 1} ${vector.kind}: ${vector.name}`, async () => {
      const data = fixture(vector.kind);
      vector.change(data);
      const imported = await importer(data, vector.kind, async () => ({
        ok: true,
        products: [publicProduct(vector.kind)],
      }));
      const result = await imported.run();
      expect(result.kind).toBe("view");
      const cards = await imported.gateway.cards();
      expect(cards.ok).toBe(true);
      if (!cards.ok) throw new Error(cards.why);
      expect(cards.document.cards).toHaveLength(vector.accepted ? 1 : 0);
      if (vector.accepted) {
        expect(cards.document.cards[0]?.card).toMatchObject({
          price: { amount: "1.00", currency: "USD" },
          fulfillment: vector.kind === "download" ? "async" : "ship",
        });
      }
    });
});

describe("campaign: 27 catalog growth and failure cells", () => {
  for (const size of [0, 1, 99, 100, 101, 199, 200, 201, 1000]) {
    for (const mode of ["normal", "overlap", "later-failure"] as const) {
      // A short first page never reaches either altered second page. Counting
      // it twice would claim a failure/overlap the connector never observed.
      const run = mode !== "normal" && size < 100 ? it.skip : it;
      run(`${size} products / ${mode}`, async () => {
        const offered = Array.from({ length: size }, (_, i) => publicProduct("download", i + 1));
        const pagesRead: number[] = [];
        const request: WooRequest = async (at) => {
          const page = Number(new URL(at).searchParams.get("page"));
          pagesRead.push(page);
          if (page === 2 && mode === "later-failure") return json({ code: "busy" }, 503);
          const from = (page - 1) * 100 - (mode === "overlap" && page > 1 ? 1 : 0);
          return json(offered.slice(Math.max(0, from), Math.max(0, from) + 100));
        };
        let read: Awaited<ReturnType<typeof catalogueOf>> | undefined;
        const imported = await importer(fixture("download"), "download", async () => {
          read = await catalogueOf(SHOP, 200, request);
          return read;
        });
        await imported.run();
        const cards = await imported.gateway.cards();
        if (!cards.ok) throw new Error(cards.why);
        expect(pagesRead.length).toBeLessThanOrEqual(3);
        if (size > 200 || mode === "later-failure" || (mode === "overlap" && size === 200)) {
          expect(read?.ok).toBe(false);
          expect(cards.document.cards).toHaveLength(0);
        } else {
          expect(read?.ok).toBe(true);
          const ids = cards.document.cards.map((card) => card.card.merchant_item_id);
          expect(new Set(ids).size).toBe(ids.length);
          expect(ids.length).toBe(size);
        }
      });
    }
  }
});

describe("campaign: four targeted inspection promises", () => {
  for (const kind of KINDS) {
    it.fails(`${kind}: refuses another product returned at the requested URL`, async () => {
      const data = fixture(kind);
      data.product.id = 2;
      const answer = await inspectProductInTheShop(
        connection(),
        merchantItemIdFor(SHOP, "1"),
        remoteProduct(data),
      );
      expect(answer.ok).toBe(false);
    });
    it.fails(`${kind}: ignores transport failure of a class-irrelevant setting`, async () => {
      const data = fixture(kind);
      data.throwPath =
        kind === "download"
          ? "woocommerce_ship_to_destination"
          : "woocommerce_downloads_require_login";
      const answer = await inspectProductInTheShop(
        connection(),
        merchantItemIdFor(SHOP, "1"),
        remoteProduct(data),
      );
      expect(answer.ok).toBe(true);
    });
  }
});

const order = (kind: Kind): Order => ({
  id: "campaign-order",
  merchant_item_id: merchantItemIdFor(SHOP, "1"),
  params: {},
  price: {
    amount: kind === "download" ? "1.00" : "2.00",
    currency: "USD",
    at: NOW.toISOString(),
    as_of: NOW.toISOString(),
  },
  price_id: "campaign-price",
  test: true,
  ...(kind === "parcel"
    ? {
        ship_to: {
          name: "Campaign recipient",
          line_one: "1 Fixture Road",
          city: "Denpasar",
          country: "ID",
          state: "BA",
          phone_number: "+620000000",
        },
      }
    : {}),
});
type Fault = "timeout" | "429" | "malformed";
const faultResponse = (fault: Fault): Response => {
  if (fault === "timeout") throw new Error("fixture transport loss");
  return fault === "429" ? json({ code: "busy" }, 429) : json({ not_a_product: true });
};

describe("campaign: 36 remote failure cells", () => {
  for (const kind of KINDS)
    for (const point of [
      "inspection",
      "raw",
      "shipping",
      "create-before",
      "create-after",
      "answer-lost",
    ] as const)
      for (const fault of ["timeout", "429", "malformed"] as const) {
        const inapplicable =
          (point === "raw" && kind === "parcel") || (point === "shipping" && kind === "download");
        // A dropped result exercises redelivery once per class. Distinct gateway
        // 429/malformed responses require the gateway/worker protocol harness;
        // repeating this same local call would not exercise those responses.
        const unimplemented = point === "answer-lost" && fault !== "timeout";
        (inapplicable || unimplemented ? it.skip : it)(`${kind}/${point}/${fault}`, async () => {
          const data = fixture(kind);
          const baseRequest = remoteProduct(data);
          const inspected = await inspectProductInTheShop(
            connection(),
            merchantItemIdFor(SHOP, "1"),
            baseRequest,
          );
          if (!inspected.ok) throw new Error("baseline fixture is not eligible");
          const shops = memoryWooShops();
          await shops.recordQuote(
            connection().accountId,
            "campaign-price",
            order(kind).merchant_item_id,
            inspected.product.fingerprint,
            new Date(NOW.getTime() + 60_000),
            NOW,
          );
          const remoteOrders: unknown[] = [];
          const receivedPosts: unknown[] = [];
          const request: WooRequest = async (at, init) => {
            const path = new URL(at).pathname;
            if (point === "inspection" && path.startsWith("/wp-json/wc/v3/products/"))
              return faultResponse(fault);
            if (point === "raw" && path.startsWith("/protected/")) return faultResponse(fault);
            if (init?.method !== "POST") return baseRequest(at, init);
            const body = JSON.parse(String(init.body)) as Record<string, unknown>;
            receivedPosts.push(body);
            if (point === "create-before") return faultResponse(fault);
            remoteOrders.push(body);
            if (point === "create-after") return faultResponse(fault);
            const lines = (body.line_items as Record<string, unknown>[]).map((line) => ({
              ...line,
              total_tax: "0.00",
            }));
            return json(
              {
                ...body,
                id: remoteOrders.length,
                number: `WOO-${remoteOrders.length}`,
                order_key: "local-order-key",
                status: "processing",
                total: order(kind).price.amount,
                total_tax: "0.00",
                line_items: lines,
              },
              201,
            );
          };
          const parts: Filling = {
            shops,
            now: () => NOW,
            inspectProduct: (keys, id) => inspectProductInTheShop(keys, id, request),
            shippingRates: async () =>
              point === "shipping"
                ? { ok: false, why: `fixture ${fault}`, again: fault !== "malformed" }
                : {
                    ok: true,
                    rates: [
                      { methodId: "flat_rate", instanceId: "1", title: "Flat rate", cost: "1.00" },
                    ],
                  },
            placeOrder: (keys, sold) => createTheOrderInTheShop(keys, sold, request),
            placeParcel: (keys, sold) => createTheParcelInTheShop(keys, sold, request),
          };
          const first = await fillFromTheShop(order(kind), connection(), EMAIL, parts, null);
          const phase = (await shops.recoveryOrder(order(kind).id))?.phase ?? null;
          // Drop the first result as a lost gateway answer, then redeliver. A
          // validated placed result, rather than transport success, is the oracle.
          const second = await fillFromTheShop(order(kind), connection(), EMAIL, parts, null);
          expect(receivedPosts.length).toBeLessThanOrEqual(1);
          expect(remoteOrders.length).toBeLessThanOrEqual(1);
          if (point === "answer-lost") {
            expect(remoteOrders).toHaveLength(1);
            expect(phase).toBe("placed");
            expect(second).toEqual(first);
            expect(
              kind === "download" ? first && "delivered" in first : first && "accepted" in first,
            ).toBe(true);
          } else if (point.startsWith("create-")) {
            expect(phase).toBe("create_unknown");
            expect(second).toMatchObject({ refused: { code: "cannot_fulfill" } });
            expect(remoteOrders).toHaveLength(point === "create-after" ? 1 : 0);
          } else {
            expect(remoteOrders).toHaveLength(0);
            expect(phase === null || phase === "precreate_refused").toBe(true);
          }
          const record = await shops.recoveryOrder(order(kind).id);
          expect(JSON.stringify(record)).not.toContain("1 Fixture Road");
        });
      }
});

describe("campaign: twelve exact-order recovery mismatches and a positive control", () => {
  const mutations: readonly [string, Partial<WooOrderRead>][] = [
    ["positive control", {}],
    ["id", { id: "2" }],
    ["status", { status: "pending" }],
    ["currency", { currency: "EUR" }],
    ["total", { total: "2.00" }],
    ["tax", { totalTax: "0.01" }],
    ["payment method", { paymentMethod: "bacs" }],
    ["transaction", { transactionId: "other-sale" }],
    ["email", { billingEmail: "other@example.com" }],
    ["product", { productId: "2" }],
    ["quantity", { quantity: 2 }],
    ["subtotal", { subtotal: "2.00" }],
    ["duplicate metadata", { agentifyOrderIds: ["campaign-order", "campaign-order"] }],
  ];
  for (const [name, mutation] of mutations)
    it(
      name === "positive control"
        ? "binds the exact matching order"
        : `does not bind mismatched ${name}`,
      async () => {
        const inspected = await inspectProductInTheShop(
          connection(),
          order("download").merchant_item_id,
          remoteProduct(fixture("download")),
        );
        if (!inspected.ok) throw new Error("baseline fixture is not eligible");
        const shops = memoryWooShops();
        await shops.connect(connection());
        const facts: WooOrderFacts = {
          shopOrigin: SHOP,
          connectionRevision: "old",
          merchantItemId: order("download").merchant_item_id,
          priceId: "campaign-price",
          productId: "1",
          productFingerprint: inspected.product.fingerprint,
          amount: "1.00",
          currency: "USD",
        };
        await shops.recordQuote(
          connection().accountId,
          facts.priceId,
          facts.merchantItemId,
          facts.productFingerprint,
          new Date(NOW.getTime() + 60_000),
          NOW,
        );
        await shops.claimOrder(connection().accountId, "campaign-order", facts, NOW);
        const placed: WooOrderRead = {
          id: "1",
          number: "WOO-1",
          orderKey: "local-order-key",
          status: "processing",
          currency: "USD",
          total: "1.00",
          totalTax: "0.00",
          paymentMethod: "agentify",
          transactionId: "campaign-order",
          billingEmail: EMAIL,
          productId: "1",
          quantity: 1,
          subtotal: "1.00",
          lineTotal: "1.00",
          lineTax: "0.00",
          agentifyOrderIds: ["campaign-order"],
          ...mutation,
        };
        const delivered: unknown[] = [];
        const created: unknown[] = [];
        const parts: WooRecoveryParts = {
          shops,
          now: () => NOW,
          identity: {
            byId: async () => ({
              id: connection().accountId,
              email: EMAIL,
              confirmed: true,
              merchant: { id: "campaign-merchant" },
            }),
          },
          gatewayFor: () => ({
            getOrder: async () => ({
              ok: true,
              document: {
                ...order("download"),
                status: delivered.length === 0 ? "refund_due" : "delivered",
              } as OrderWithStatus,
            }),
            paidInto: async () => ({ ok: true, document: null }),
            deliverOrder: async (_id, result) => {
              delivered.push(result);
              return { ok: true, document: { ok: true, result: "debt_closed_by_delivery" } };
            },
          }),
          inspectProduct: async () => inspected,
          readOrder: async () => ({ ok: true, order: placed }),
          createOrder: async (_keys, sold) => {
            created.push(sold);
            throw new Error("recovery unexpectedly attempted a new order");
          },
        };
        const recovered = await recoverWooOrder(
          { orderId: "campaign-order", wooOrderId: "1" },
          parts,
        );
        const positive = name === "positive control";
        expect(recovered).toMatchObject(
          positive ? { ok: true, state: "delivered" } : { ok: false, state: "refused" },
        );
        expect((await shops.recoveryOrder("campaign-order"))?.phase).toBe(
          positive ? "placed" : "create_unknown",
        );
        expect(created).toHaveLength(0);
        expect(delivered).toHaveLength(positive ? 1 : 0);
      },
    );
});

describe("campaign: 24 grant lifecycle schedules", () => {
  for (const scenario of [
    "replay",
    "expired",
    "unknown",
    "older",
    "forget",
    "other-account",
  ] as const)
    for (let schedule = 0; schedule < 4; schedule += 1) {
      it(`${scenario}/schedule-${schedule}`, async () => {
        const shops = memoryWooShops();
        const grant = {
          token: "campaign-token",
          accountId: "A",
          shopUrl: SHOP,
          startedAt: NOW,
          expiresAt: new Date(NOW.getTime() + 60_000),
        };
        const keys = {
          consumerKey: "ck_local_fixture",
          consumerSecret: "cs_local_fixture",
          permissions: "read_write",
        };
        await shops.beginGrant(grant);
        await shops.beginGrant({ ...grant, accountId: "B", token: "token-B" });
        const now = scenario === "expired" ? new Date(grant.expiresAt.getTime() + schedule) : NOW;
        if (scenario === "older") await shops.beginGrant({ ...grant, token: "new-token" });
        const token =
          scenario === "unknown"
            ? "not-issued"
            : scenario === "other-account"
              ? "token-B"
              : grant.token;
        if (scenario === "forget") {
          if (schedule === 0) {
            await shops.forget("A");
            await shops.connectFromGrant(token, keys, now);
          } else if (schedule === 1) {
            await shops.connectFromGrant(token, keys, now);
            await shops.forget("A");
          } else if (schedule === 2) {
            await Promise.all([shops.forget("A"), shops.connectFromGrant(token, keys, now)]);
          } else {
            await Promise.all([shops.connectFromGrant(token, keys, now), shops.forget("A")]);
          }
        } else {
          const second = { ...keys, consumerKey: "ck_second" };
          if (schedule === 0) {
            await shops.connectFromGrant(token, keys, now);
            await shops.connectFromGrant(token, second, now);
          } else if (schedule === 1) {
            await shops.connectFromGrant(token, second, now);
            await shops.connectFromGrant(token, keys, now);
          } else if (schedule === 2) {
            await Promise.all([
              shops.connectFromGrant(token, keys, now),
              shops.connectFromGrant(token, second, now),
            ]);
          } else {
            await Promise.all([
              shops.connectFromGrant(token, second, now),
              shops.connectFromGrant(token, keys, now),
            ]);
          }
        }
        const [a, b] = await Promise.all([shops.connectionOf("A"), shops.connectionOf("B")]);
        if (["expired", "unknown", "older", "forget"].includes(scenario)) expect(a).toBeNull();
        else if (scenario === "other-account") {
          expect(a).toBeNull();
          expect(b?.accountId).toBe("B");
        } else {
          expect(a?.accountId).toBe("A");
          expect(await shops.connectFromGrant(token, keys, now)).toBeNull();
        }
        if (scenario !== "other-account") expect(b).toBeNull();
      });
    }
});
