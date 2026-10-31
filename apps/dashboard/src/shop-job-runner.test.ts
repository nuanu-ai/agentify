import { type Harness, harness } from "@agentify/gateway/testing";
import { wooRefusal } from "@agentify/recorded";
import { afterEach, describe, expect, it, vi } from "vitest";
import { gatewayFor } from "./gateway.js";
import { liveSalesMessage } from "./live-sales-message.js";
import { publicationMailEvent } from "./live-sales-publication.js";
import {
  type ShopWorkParts,
  shopPublisherFor,
  startShopJobs,
  workShopJob,
} from "./shop-job-runner.js";
import { shopJobView } from "./shop-job-view.js";
import { cardsFromTheShop, type StoreProduct } from "./woo-catalog.js";
import type { WooRequest } from "./woo-request.js";
import {
  type ConnectedCatalogueEvent,
  inspectProductsInTheShop,
  type ProductInspection,
} from "./woo-shop.js";
import { memoryWooShops } from "./woo-shops.js";

const SHOP = "https://woo.nuanu.ai";
const product = (id: number): StoreProduct => ({
  id,
  name: "Guide " + id,
  sku: "guide-" + id,
  type: "simple",
  description: "A downloadable guide.",
  short_description: "",
  is_purchasable: true,
  is_in_stock: true,
  status: "publish",
  virtual: true,
  downloadable: true,
  manage_stock: false,
  download_limit: -1,
  download_expiry: -1,
  downloads: [{ id: "guide", name: "Guide", file: SHOP + "/guide.pdf" }],
  qualification_problem: null,
  prices: { price: "2500", currency_code: "USD", currency_minor_unit: 2 },
});
const eligible = (id: number): Extract<ProductInspection, { ok: true }> => ({
  ok: true,
  product: {
    kind: "download",
    productId: String(id),
    downloadId: "guide",
    fileName: "Guide",
    price: { amount: "25.00", currency: "USD" },
    fingerprint: "observed-guide",
    tax: { mode: "off" },
  },
});
const item = (
  id: number,
  inspected: ProductInspection = eligible(id),
): ConnectedCatalogueEvent => ({
  kind: "product",
  product: product(id),
  inspected,
});
const currency: ConnectedCatalogueEvent = {
  kind: "currency",
  currency: { code: "USD", decimals: 2 },
};
const complete: ConnectedCatalogueEvent = { kind: "complete", total: 1 };
const removed: ProductInspection = {
  ok: false,
  again: false,
  saidNo: true,
  why: "The shop deleted this product.",
  obstacle: { group: "not_selling", reason: "deleted", withdraw: true },
};
const fixtures: Harness[] = [];
afterEach(async () => {
  for (const one of fixtures.splice(0)) await one.stop();
});
async function setup(events: readonly ConnectedCatalogueEvent[], sellerSite?: string | null) {
  const h = await harness({}, { sellerSite });
  fixtures.push(h);
  const shops = memoryWooShops();
  const person = {
    id: "owner",
    email: "owner@example.com",
    confirmed: true,
    merchant: { id: h.merchant.id },
  };
  const connection = {
    accountId: person.id,
    shopUrl: SHOP,
    consumerKey: "ck_fixed",
    consumerSecret: "cs_fixed",
    permissions: "read_write",
    revision: "grant-1",
    connectedAt: new Date(),
    currency: null,
  };
  await shops.connect(connection);
  const acting = { merchantId: h.merchant.id, email: person.email };
  const gateway = gatewayFor(h.gateway, acting, undefined, shops.cardPauses);
  await gateway.sellThrough("woocommerce");
  const parts: ShopWorkParts = {
    shops,
    identity: { byId: async (id) => (id === person.id ? person : null) },
    clientFor: (who) => gatewayFor(h.gateway, who),
    publisherFor: (who) => shopPublisherFor(h.gateway, who, shops),
    catalogue: async function* () {
      yield* events;
    },
    inspect: async () => {
      throw new Error(
        "This test did not say what the shop answers about a card missing from its list.",
      );
    },
    surfaceMode: "sandbox",
  };
  const run = async (
    kind: "check" | "publish" = "publish",
    override: Partial<ShopWorkParts> = {},
  ) => {
    if (kind === "publish")
      await shops.noteCurrency(person.id, { code: "USD", decimals: 2 }, connection.revision);
    await shops.jobs.request({
      merchantId: h.merchant.id,
      accountId: person.id,
      connectionRevision: connection.revision,
      shopUrl: SHOP,
      ...(kind === "publish"
        ? { kind, currency: { code: "USD", decimals: 2 }, rate: null }
        : { kind }),
    });
    const claimed = await shops.jobs.claim();
    if (!claimed) throw new Error("No accepted job");
    await workShopJob(claimed, { ...parts, ...override });
    return (await shops.jobs.latest(h.merchant.id))[0];
  };
  const seed = async (id: number) => {
    const card = cardsFromTheShop([product(id)], SHOP, { currency: "USD", decimals: 2, rate: null })
      .cards[0]?.card;
    if (!card) throw new Error("The fixed product is invalid");
    const made = await gateway.publishCard(card);
    if (!made.ok || !made.document.ok) throw new Error("The gateway refused the product");
    return made.document.id;
  };
  return { h, shops, person, gateway, parts, run, seed };
}

describe("a durable shop job", () => {
  it("counts accepted publication separately from the seller's paused sales", async () => {
    const s = await setup([currency, item(11), complete]);
    await s.gateway.setSelling(false);
    await s.run();
    expect(await s.h.store.cards(s.h.merchant.id)).toHaveLength(1);
    expect(await shopJobView(s.shops, s.h.merchant.id, new URLSearchParams())).toMatchObject({
      published: 0,
    });
    expect(
      s.shops.recordedAnalytics
        .map(({ event }) => event)
        .filter((event) => event.name === "agc_setup_result" && event.fields.step === "woo_import"),
    ).toMatchObject([
      {
        actor: "human",
        source: "dashboard",
        fields: { outcome: "completed", imported_count: 1, failed_count: 0, skipped_count: 0 },
      },
    ]);
  });
  it("checks products without seller settings and returns its stored result to a new reader", async () => {
    const s = await setup([currency, item(11), complete], null);
    const bare = await s.h.store.addMerchant(
      { id: "mch_unprepared", name: "New shop" },
      Date.now(),
    );
    if (!bare) throw new Error("The new merchant was not made");
    expect(bare).toMatchObject({
      serviceName: null,
      sellerSite: null,
      payoutWallet: { address: null },
      liveApprovedAt: null,
    });
    await s.shops.jobs.request({
      merchantId: bare.id,
      accountId: s.person.id,
      connectionRevision: "grant-1",
      shopUrl: SHOP,
      kind: "check",
    });
    const job = await s.shops.jobs.claim();
    if (!job) throw new Error("The check was not queued");
    await workShopJob(job, {
      ...s.parts,
      surfaceMode: "live",
      identity: { byId: async () => ({ ...s.person, merchant: { id: bare.id } }) },
    });
    const view = await shopJobView(s.shops, bare.id, new URLSearchParams());
    expect(view).toMatchObject({ status: "completed", ready: 1, published: 0, total: 1 });
    expect(await s.h.store.cards(bare.id)).toEqual([]);
    expect(await shopJobView(s.shops, "another-merchant", new URLSearchParams())).toBeNull();
  });
  it.each([false, true])(
    "retains a reliable total but invalidates a contradicted total (%s)",
    async (contradicted) => {
      const s = await setup([
        currency,
        { kind: "total", total: 200 },
        item(11),
        ...(contradicted ? [{ kind: "total" as const, total: null }] : []),
        { kind: "stopped", why: "The second page did not answer reliably.", reconnect: false },
      ]);
      expect(await s.run("check")).toMatchObject({
        status: "stopped",
        read: 1,
        total: contradicted ? null : 200,
        stopCode: "unread",
      });
      expect(await shopJobView(s.shops, s.h.merchant.id, new URLSearchParams())).toMatchObject({
        read: 1,
        total: contradicted ? null : 200,
      });
    },
  );
  it("a check that reads more products than the shop's count claims no count it outgrew", async () => {
    const s = await setup([
      currency,
      { kind: "total", total: 1 },
      item(11),
      item(12),
      { kind: "stopped", why: "The next page timed out.", reconnect: false },
    ]);
    expect(await s.run("check")).toMatchObject({ status: "stopped", read: 2, total: null });
  });
  it("a publication without a site stops before any protected catalogue read", async () => {
    const s = await setup([currency, item(11), complete], null);
    const result = await s.run("publish", {
      catalogue: async function* () {
        yield await Promise.reject(new Error("A blocked publication reached the shop"));
      },
    });
    expect(result).toMatchObject({ status: "stopped", read: 0, stopCode: "changed" });
    expect(await s.h.store.cards(s.h.merchant.id)).toEqual([]);
  });
  it("the publisher's single-card lookup refuses another tenant's exact card", async () => {
    const s = await setup([currency, item(11), complete]);
    const id = await s.seed(11);
    const other = await s.h.addMerchant();
    expect(
      await shopPublisherFor(
        s.h.gateway,
        {
          merchantId: other.id,
          email: "other@example.com",
        },
        s.shops,
      ).read(id),
    ).toBeNull();
  });
  it("discovers a non-dollar currency even for an empty shop and waits for its chosen rate", async () => {
    const s = await setup([
      { kind: "currency", currency: { code: "IDR", decimals: 0 } },
      { kind: "complete", total: 0 },
    ]);
    expect(await s.run("check")).toMatchObject({
      status: "stopped",
      stopCode: "rate_required",
      currency: { code: "IDR", decimals: 0 },
      rate: null,
    });
    expect((await s.shops.connectionOf(s.person.id))?.currency).toEqual({
      code: "IDR",
      decimals: 0,
    });
    expect(await s.h.store.cards(s.h.merchant.id)).toEqual([]);
  });
  it("publishes through a replaceable boundary and preserves an unknown delivery outcome", async () => {
    const s = await setup([
      currency,
      { kind: "total", total: 2 },
      item(11),
      item(12),
      { kind: "complete", total: 2 },
    ]);
    const result = await s.run("publish", {
      publisherFor: () => ({
        cards: async () => [],
        read: async () => null,
        pause: async () => undefined,
        publish: async () => null,
      }),
    });
    expect(result).toMatchObject({ status: "stopped", stopCode: "unknown", read: 1, total: 2 });
    if (!result) throw new Error("The accepted job disappeared");
    expect(await s.shops.jobs.rows(s.h.merchant.id, result.id)).toEqual([
      expect.objectContaining({
        id: "11",
        group: "ready",
        reason: "publication_unknown",
        published: false,
      }),
    ]);
    expect(await s.h.store.cards(s.h.merchant.id)).toEqual([]);
  });
  it("a publisher exception after writing remains unknown and does not expose exception contents", async () => {
    const s = await setup([currency, item(11), complete]);
    const publish = s.h.gateway.publishCard.bind(s.h.gateway);
    const secret = "cs_private-grant-data";
    const fault = vi.spyOn(s.h.gateway, "publishCard").mockImplementationOnce(async (...args) => {
      await publish(...args);
      throw new Error(secret);
    });
    const lines: string[] = [];
    const log = vi.spyOn(console, "error").mockImplementation((...parts) => {
      lines.push(parts.join(" "));
    });
    try {
      const result = await s.run();
      expect(result).toMatchObject({ status: "stopped", stopCode: "unknown", read: 1 });
      expect(await s.h.store.cards(s.h.merchant.id)).toHaveLength(1);
      const view = await shopJobView(s.shops, s.h.merchant.id, new URLSearchParams());
      expect(view).toMatchObject({
        ready: 1,
        published: 0,
        excluded: 0,
        publicationUnknown: "Guide 11",
      });
      expect(view?.groups.some((group) => group.group === "unanswered")).toBe(false);
      expect(JSON.stringify(result)).not.toContain(secret);
      expect(lines.join("\n")).not.toContain(secret);
    } finally {
      fault.mockRestore();
      log.mockRestore();
    }
  });
  it("finishes with one on-sale snapshot after global selling changes between products", async () => {
    const s = await setup([]);
    await s.gateway.pollWorker(0);
    await s.run("publish", {
      catalogue: async function* () {
        yield currency;
        yield { kind: "total", total: 2 };
        yield item(11);
        await s.gateway.setSelling(false);
        yield item(12);
        yield { kind: "complete", total: 2 };
      },
    });
    expect(await s.h.store.cards(s.h.merchant.id)).toHaveLength(2);
    expect(await shopJobView(s.shops, s.h.merchant.id, new URLSearchParams())).toMatchObject({
      status: "completed",
      published: 0,
      excluded: 2,
    });
  });
  it("stops publication when account readiness changes, without calling it a product defect", async () => {
    const s = await setup([]);
    const result = await s.run("publish", {
      catalogue: async function* () {
        yield currency;
        yield { kind: "total", total: 2 };
        yield item(11);
        await s.h.store.setServiceName(s.h.merchant.id, null, Date.now());
        yield item(12);
        yield { kind: "complete", total: 2 };
      },
    });
    expect(result).toMatchObject({ status: "stopped", stopCode: "changed", read: 2 });
    expect(await s.h.store.cards(s.h.merchant.id)).toHaveLength(1);
    const view = await shopJobView(s.shops, s.h.merchant.id, new URLSearchParams());
    expect(view?.groups.some((group) => group.group === "fix")).toBe(false);
    expect(view?.why).toContain("account");
  });
  it("a direct known-product access refusal requires reconnect and leaves the card on sale", async () => {
    const s = await setup([currency, { kind: "complete", total: 0 }]);
    const id = await s.seed(11);
    const result = await s.run("publish", {
      inspect: async (_keys, items) =>
        items.map(() => ({
          ok: false,
          again: false,
          saidNo: false,
          reconnect: true,
          why: "The protected product check refused access.",
        })),
    });
    expect(result).toMatchObject({ status: "stopped", stopCode: "reconnect", read: 1 });
    expect(await s.h.store.cardById(id)).toMatchObject({
      paused: false,
    });
  });
  it("counts only real connector-owned pause and resume transitions", async () => {
    const s = await setup([currency, { kind: "complete", total: 0 }]);
    const id = await s.seed(11);
    const publisher = shopPublisherFor(
      s.h.gateway,
      {
        merchantId: s.h.merchant.id,
        email: "owner@example.com",
      },
      s.shops,
    );
    await publisher.pause(id, "stopped_selling");
    await publisher.pause(id, "stopped_selling");
    await publisher.pause(id, null);
    await publisher.pause(id, null);
    await s.h.store.setCardPaused(s.h.merchant.id, id, true);
    await publisher.pause(id, null);
    expect(
      s.h.store.recordedAnalytics
        .filter(({ event }) => event.name === "agc_selling_changed")
        .map(({ event }) => event),
    ).toEqual([
      {
        name: "agc_selling_changed",
        actor: "system",
        source: "woocommerce",
        refs: { merchant: s.h.merchant.id, item: id },
        fields: { entity: "card", change: "paused" },
      },
      {
        name: "agc_selling_changed",
        actor: "system",
        source: "woocommerce",
        refs: { merchant: s.h.merchant.id, item: id },
        fields: { entity: "card", change: "resumed" },
      },
    ]);
    expect((await s.h.store.cardById(id))?.paused).toBe(true);
  });

  it("withdraws a directly confirmed deleted product only after a complete catalogue", async () => {
    const s = await setup([currency, { kind: "complete", total: 0 }]);
    const id = await s.seed(11);
    await s.run("publish", { inspect: async (_keys, items) => items.map(() => removed) });
    expect(await s.h.store.cardById(id)).toMatchObject({
      paused: true,
    });
  });
  it("asks the shop about missing cards within its request bound and never again once withdrawn", async () => {
    const s = await setup([currency, { kind: "complete", total: 0 }]);
    const ids = [];
    for (let id = 1; id <= 30; id++) ids.push(await s.seed(id));
    let inFlight = 0;
    let most = 0;
    const asked: string[] = [];
    const deleted = wooRefusal("woocommerce_rest_product_invalid_id");
    const shop: WooRequest = async (url) => {
      inFlight += 1;
      most = Math.max(most, inFlight);
      try {
        await new Promise((resolve) => setTimeout(resolve, 1));
        const { pathname, search } = new URL(String(url));
        asked.push(pathname + search);
        if (pathname.includes("/settings/"))
          return Response.json({ id: pathname.split("/").at(-1), value: "no" });
        if (pathname === "/wp-json/wc/v3/products") return Response.json([]);
        return Response.json(deleted.body, { status: deleted.status });
      } finally {
        inFlight -= 1;
      }
    };
    const inspect: ShopWorkParts["inspect"] = (keys, items) =>
      inspectProductsInTheShop(keys, items, shop);
    await s.run("publish", { inspect });
    for (const id of ids) expect((await s.h.store.cardById(id))?.paused, id).toBe(true);
    expect(most).toBeLessThanOrEqual(4);
    expect(asked.filter((path) => path.includes("/settings/")).length).toBeLessThanOrEqual(11);
    asked.length = 0;
    await s.run("publish", { inspect });
    expect(asked).toEqual([]);
  });
  it("keeps the published card when its current price no longer satisfies the card contract", async () => {
    const s = await setup([
      currency,
      {
        kind: "product",
        product: {
          ...product(11),
          prices: { price: "0", currency_code: "USD", currency_minor_unit: 2 },
        },
        inspected: {
          ok: true,
          product: { ...eligible(11).product, price: { amount: "0.00", currency: "USD" } },
        },
      },
      complete,
    ]);
    const id = await s.seed(11);
    await s.run();
    expect(await s.h.store.cardById(id)).toMatchObject({
      paused: false,
    });
  });
  it.each(["", "<p></p>"])(
    "keeps the last published text when the shop description needs fixing: %s",
    async (description) => {
      const current = { ...product(11), description, short_description: "" };
      const s = await setup([
        currency,
        { kind: "product", product: current, inspected: eligible(11) },
        complete,
      ]);
      const id = await s.seed(11);
      const job = await s.run();
      if (!job) throw new Error("The finished job is missing.");
      expect(await s.h.store.cardById(id)).toMatchObject({
        paused: false,
        card: { description: "A downloadable guide." },
      });
      expect(await s.shops.jobs.rows(s.h.merchant.id, job.id)).toMatchObject([
        { group: "fix", reason: "product_content" },
      ]);
    },
  );
  it.each(["listed", "missing"] as const)(
    "completes a traversed shop and withdraws confirmed products despite one unread %s product",
    async (where) => {
      const unreadInspection = {
        ok: false as const,
        again: true as const,
        why: "Product read timed out.",
      };
      const s = await setup([
        currency,
        item(11, removed),
        ...(where === "listed" ? [item(12, unreadInspection)] : []),
        complete,
      ]);
      const deleted = await s.seed(11);
      const unread = await s.seed(12);
      expect(
        await s.run("publish", {
          inspect: async (_keys, items) => items.map(() => unreadInspection),
        }),
      ).toMatchObject({
        status: "completed",
        stopCode: null,
      });
      expect(await s.h.store.cardById(deleted)).toMatchObject({ paused: true });
      expect(await s.h.store.cardById(unread)).toMatchObject({ paused: false });
    },
  );
  it.each([true, false])(
    "a partial catalogue keeps known cards, including observed withdrawals (explicit stop: %s)",
    async (explicitStop) => {
      const s = await setup([
        currency,
        item(11, removed),
        ...(explicitStop
          ? [{ kind: "stopped" as const, why: "The next page timed out.", reconnect: false }]
          : []),
      ]);
      const id = await s.seed(11);
      expect(await s.run()).toMatchObject({ status: "stopped", stopCode: "unread" });
      expect(await s.h.store.cardById(id)).toMatchObject({
        paused: false,
      });
    },
  );
  it("a returned product resumes only the connector pause and preserves seller and shop pauses", async () => {
    const s = await setup([currency, item(11), complete]);
    const id = await s.seed(11);
    await shopPublisherFor(
      s.h.gateway,
      { merchantId: s.h.merchant.id, email: s.person.email },
      s.shops,
    ).pause(id, "stopped_selling");
    await s.run("publish", {
      catalogue: async function* () {
        yield currency;
        yield item(11);
        yield complete;
      },
    });
    expect(await s.h.store.cardById(id)).toMatchObject({
      paused: false,
    });
    await s.h.store.setCardPaused(s.h.merchant.id, id, true);
    await s.run("publish", {
      catalogue: async function* () {
        yield currency;
        yield item(11);
        yield complete;
      },
    });
    expect(await s.h.store.cardById(id)).toMatchObject({ paused: true });
    expect(await shopJobView(s.shops, s.h.merchant.id, new URLSearchParams())).toMatchObject({
      published: 0,
      excluded: 1,
    });
    await s.h.store.setCardPaused(s.h.merchant.id, id, false);
    await s.gateway.setSelling(false);
    await s.run("publish", {
      catalogue: async function* () {
        yield currency;
        yield item(11);
        yield complete;
      },
    });
    expect(await s.h.store.cardById(id)).toMatchObject({ paused: false });
    expect(await shopJobView(s.shops, s.h.merchant.id, new URLSearchParams())).toMatchObject({
      published: 0,
      excluded: 1,
    });
  });
  it("a card the seller resumes during a sync is shown on sale without the paused note", async () => {
    const s = await setup([]);
    await s.gateway.pollWorker(0);
    const id = await s.seed(11);
    await s.h.store.setCardPaused(s.h.merchant.id, id, true);
    await s.run("publish", {
      catalogue: async function* () {
        yield currency;
        yield item(11);
        await s.h.store.setCardPaused(s.h.merchant.id, id, false);
        yield complete;
      },
    });
    const view = await shopJobView(s.shops, s.h.merchant.id, new URLSearchParams());
    expect(view).toMatchObject({ published: 1 });
    const onSale = view?.groups.find((group) => group.group === "ready");
    expect(onSale?.reasons.map((reason) => reason.why)).not.toContain("Paused by you in Agentify");
  });
  it("a seller's pause that fails to save leaves the shop's withdrawal with the connector", async () => {
    const s = await setup([]);
    const id = await s.seed(11);
    await shopPublisherFor(
      s.h.gateway,
      { merchantId: s.h.merchant.id, email: s.person.email },
      s.shops,
    ).pause(id, "stopped_selling");
    const fault = vi
      .spyOn(s.h.gateway, "setCardPaused")
      .mockRejectedValueOnce(new Error("the card store is unavailable"));
    try {
      await expect(s.gateway.pauseCard(id, true)).rejects.toThrow("the card store is unavailable");
    } finally {
      fault.mockRestore();
    }
    expect(await s.shops.cardPauses.list(s.h.merchant.id)).toMatchObject({
      [id]: { reason: "stopped_selling" },
    });
  });
  it("a seller claiming an already connector-paused card keeps it paused through sync", async () => {
    const s = await setup([currency, item(11), complete]);
    const id = await s.seed(11);
    await shopPublisherFor(
      s.h.gateway,
      { merchantId: s.h.merchant.id, email: s.person.email },
      s.shops,
    ).pause(id, "stopped_selling");
    expect(await s.gateway.pauseCard(id, false)).toMatchObject({ ok: false, status: 409 });
    expect(await s.gateway.cards()).toMatchObject({
      ok: true,
      document: {
        integrationPauses: { [id]: { at: expect.any(Number), reason: "stopped_selling" } },
      },
    });
    expect(await s.gateway.pauseCard(id, true)).toMatchObject({ ok: true });
    expect(await s.shops.cardPauses.list(s.h.merchant.id)).toEqual({});
    await s.run();
    expect(await s.h.store.cardById(id)).toMatchObject({ paused: true });
  });
  it("a rate changed during publication leaves the connector pause in place", async () => {
    const s = await setup([]);
    const id = await s.seed(11);
    await shopPublisherFor(
      s.h.gateway,
      { merchantId: s.h.merchant.id, email: s.person.email },
      s.shops,
    ).pause(id, "stopped_selling");
    const idr = { code: "IDR", decimals: 0 } as const;
    await s.shops.noteCurrency(s.person.id, idr, "grant-1");
    const rateEntry = {
      currency: "IDR",
      rate: "16000",
      setAt: new Date(),
      sessionSignedInAt: null,
      reference: null,
      confirmed: false,
    };
    await s.shops.saveRate(s.person.id, SHOP, rateEntry);
    const rate = await s.shops.currentRate(s.person.id, SHOP, "IDR");
    if (!rate) throw new Error("The chosen rate was not saved");
    await s.shops.jobs.request({
      merchantId: s.h.merchant.id,
      accountId: s.person.id,
      connectionRevision: "grant-1",
      shopUrl: SHOP,
      kind: "publish",
      currency: idr,
      rate: { ...rate, setAt: rate.setAt.toISOString() },
    });
    const job = await s.shops.jobs.claim();
    if (!job) throw new Error("The publication was not queued");
    let reached: () => void = () => {};
    const written = new Promise<void>((resolve) => {
      reached = resolve;
    });
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const running = workShopJob(job, {
      ...s.parts,
      catalogue: async function* () {
        yield { kind: "currency", currency: idr };
        yield {
          kind: "product",
          product: {
            ...product(11),
            prices: { price: "400000", currency_code: "IDR", currency_minor_unit: 0 },
          },
          inspected: eligible(11),
        };
        yield complete;
      },
      publisherFor: (who) => {
        const real = shopPublisherFor(s.h.gateway, who, s.shops);
        return {
          ...real,
          publish: async (card) => {
            const result = await real.publish(card);
            reached();
            await held;
            return result;
          },
        };
      },
    });
    await written;
    try {
      await s.shops.saveRate(s.person.id, SHOP, { ...rateEntry, rate: "17000" });
    } finally {
      release();
    }
    await running;
    expect(await s.h.store.cardById(id)).toMatchObject({
      paused: true,
    });
    expect((await s.shops.jobs.latest(s.h.merchant.id))[0]).toMatchObject({
      status: "stopped",
      stopCode: "changed",
    });
  });
  it("shutdown waits for the active read, retains progress, and restart does not replay publication", async () => {
    const s = await setup([]);
    let reached: () => void = () => {};
    const reading = new Promise<void>((resolve) => {
      reached = resolve;
    });
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    await s.shops.noteCurrency(s.person.id, { code: "USD", decimals: 2 }, "grant-1");
    await s.shops.jobs.request({
      accountId: s.person.id,
      merchantId: s.h.merchant.id,
      connectionRevision: "grant-1",
      shopUrl: SHOP,
      kind: "publish",
      currency: { code: "USD", decimals: 2 },
      rate: null,
    });
    const running = startShopJobs({
      ...s.parts,
      catalogue: async function* () {
        yield currency;
        yield { kind: "total", total: 2 };
        yield item(11);
        reached();
        await held;
        yield item(12);
        yield { kind: "complete", total: 2 };
      },
    });
    await reading;
    let closed = false;
    const closing = running.stop().then(() => {
      closed = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(closed).toBe(false);
    release();
    await closing;
    const stopped = await shopJobView(s.shops, s.h.merchant.id, new URLSearchParams());
    expect(stopped).toMatchObject({
      status: "stopped",
      stopCode: "interrupted",
      read: 1,
      total: 2,
      ready: 1,
    });
    expect(stopped?.why).toContain(stopped?.words.publish);
    const restarted = startShopJobs(s.parts);
    await restarted.ready;
    await restarted.stop();
    expect(await s.h.store.cards(s.h.merchant.id)).toHaveLength(1);
    expect(await shopJobView(s.shops, s.h.merchant.id, new URLSearchParams())).toMatchObject({
      status: "stopped",
      stopCode: "interrupted",
      read: 1,
      total: 2,
    });
  });
  it("checks a connection that has no result once, and not again at the next start", async () => {
    const s = await setup([currency, item(11), complete]);
    const first = startShopJobs(s.parts);
    try {
      await vi.waitFor(
        async () =>
          expect((await s.shops.jobs.latest(s.h.merchant.id))[0]?.status).toBe("completed"),
        { timeout: 5000 },
      );
    } finally {
      await first.stop();
    }
    const looked = Promise.withResolvers<void>();
    const next = startShopJobs({
      ...s.parts,
      identity: {
        byId: async (id) => {
          looked.resolve();
          return await s.parts.identity.byId(id);
        },
      },
    });
    try {
      await looked.promise;
      await new Promise((resolve) => setImmediate(resolve));
    } finally {
      await next.stop();
    }
    expect(await s.shops.jobs.latest(s.h.merchant.id)).toMatchObject([
      { kind: "check", sequence: 1, status: "completed" },
    ]);
  });
  it("still recovers and checks connections in a turn whose automatic publication fails", async () => {
    const s = await setup([currency, item(11), complete]);
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const worker = startShopJobs({
      ...s.parts,
      advancePublications: async () => {
        throw new Error("One merchant's publication could not be advanced.");
      },
    });
    try {
      await vi.waitFor(
        async () =>
          expect((await s.shops.jobs.latest(s.h.merchant.id))[0]).toMatchObject({
            kind: "check",
            status: "completed",
          }),
        { timeout: 5000 },
      );
    } finally {
      await worker.stop();
      log.mockRestore();
    }
  });
  it("bounds the returned rows and preserves the requested fifty-row increment", async () => {
    const s = await setup([
      currency,
      ...Array.from({ length: 75 }, (_, i) => item(i + 1)),
      { kind: "complete", total: 75 },
    ]);
    await s.run("check");
    const first = await shopJobView(s.shops, s.h.merchant.id, new URLSearchParams());
    expect(first?.groups[0]?.reasons[0]?.rows).toHaveLength(10);
    expect(first?.groups[0]?.reasons[0]?.more?.left).toBe(65);
    const next = await shopJobView(
      s.shops,
      s.h.merchant.id,
      new URLSearchParams("show_ready_ready=60"),
    );
    expect(next?.groups[0]?.reasons[0]?.rows).toHaveLength(60);
    expect(next?.groups[0]?.reasons[0]?.more?.left).toBe(15);
  });

  it("groups reasons by their stable code and keeps pagination keyed to that code", async () => {
    const obstacle = (
      why: string,
      reason: "variants" | "stock_tracking" = "variants",
    ): ProductInspection => ({
      ok: false,
      why,
      again: false,
      saidNo: true,
      obstacle: { group: "unsupported", reason, withdraw: false },
    });
    const s = await setup([
      currency,
      item(1, obstacle("The product has size options.")),
      item(2, obstacle("The product has colour options.")),
      { kind: "complete", total: 2 },
    ]);
    await s.run("check");
    const view = await shopJobView(s.shops, s.h.merchant.id, new URLSearchParams());
    const variants = view?.groups.find((group) => group.group === "unsupported")?.reasons[0];
    expect(variants).toMatchObject({
      code: "variants",
      why: "Has options such as size or colour",
      count: 2,
      rows: [{ why: "" }, { why: "" }],
    });
    const variantItems = Array.from({ length: 61 }, (_, index) =>
      item(index + 1, obstacle(`Product ${index + 1} has options.`)),
    );
    const many = await setup([currency, ...variantItems, { kind: "complete", total: 61 }]);
    await many.run("check");
    const page = await shopJobView(many.shops, many.h.merchant.id, new URLSearchParams());
    const more = page?.groups.find((group) => group.group === "unsupported")?.reasons[0]?.more;
    expect(more?.href).toContain("show_unsupported_variants=60");
    await many.run("check", {
      catalogue: async function* () {
        yield currency;
        yield item(
          0,
          obstacle("The connector imports products without stock tracking.", "stock_tracking"),
        );
        yield* variantItems;
        yield { kind: "complete", total: 62 };
      },
    });
    const next = await shopJobView(
      many.shops,
      many.h.merchant.id,
      new URLSearchParams(new URL(more?.href ?? "?", "https://agentify.ad").search),
    );
    const reordered = next?.groups.find((group) => group.group === "unsupported")?.reasons;
    expect(reordered?.map((reason) => reason.code)).toStrictEqual(["stock_tracking", "variants"]);
    expect(reordered?.[1]?.rows).toHaveLength(60);
    const oldPosition = await shopJobView(
      many.shops,
      many.h.merchant.id,
      new URLSearchParams("show_unsupported_0=60"),
    );
    expect(
      oldPosition?.groups.find((group) => group.group === "unsupported")?.reasons[1]?.rows,
    ).toHaveLength(10);

    const conditions = await setup([]);
    await conditions.shops.jobs.request({
      merchantId: conditions.h.merchant.id,
      accountId: conditions.person.id,
      connectionRevision: "grant-1",
      shopUrl: SHOP,
      kind: "check",
    });
    const conditionJob = await conditions.shops.jobs.claim();
    if (!conditionJob) throw new Error("The product condition check was not queued");
    const firstWhy = "Ships as a parcel; choose a delivery option at checkout.";
    await conditions.shops.jobs.record(
      conditionJob.id,
      {
        id: "cart-1",
        title: "Guide",
        group: "fix",
        reason: "product_conditions",
        why: firstWhy,
        published: false,
      },
      2,
    );
    await conditions.shops.jobs.record(
      conditionJob.id,
      {
        id: "cart-2",
        title: "Notebook",
        group: "fix",
        reason: "product_conditions",
        why: "Download access requires a customer login.",
        published: false,
      },
      2,
    );
    await conditions.shops.jobs.finish(conditionJob.id, {
      status: "completed",
      why: null,
      stopCode: null,
    });
    const conditionsResult = await shopJobView(
      conditions.shops,
      conditions.h.merchant.id,
      new URLSearchParams(),
    );
    expect(
      conditionsResult?.groups.find((group) => group.group === "fix")?.reasons[0],
    ).toMatchObject({
      why: "Different shop issues",
      count: 2,
      rows: [{ why: firstWhy }, { why: "Download access requires a customer login." }],
    });
  });
});

describe("a stop before the shop was read", () => {
  const admitted = {
    kind: "admitted" as const,
    approvalAt: Date.parse("2026-10-30T14:00:00Z"),
    id: "decision_one",
    at: Date.parse("2026-10-30T14:00:00Z"),
    sellerName: "Freeland",
    sellerSite: "https://freeland.app",
    integration: "woocommerce" as const,
    hasWallet: true,
    reason: null,
  };
  /** Every reader of one stopped job: the screen, the approval email and analytics. */
  const told = async (s: Awaited<ReturnType<typeof setup>>) => {
    const job = (await s.shops.jobs.latest(s.h.merchant.id))[0];
    if (!job) throw new Error("The job disappeared");
    const view = await shopJobView(s.shops, s.h.merchant.id, new URLSearchParams());
    const mail = liveSalesMessage({
      to: s.person.email,
      event: publicationMailEvent(
        { ...admitted, merchantId: s.h.merchant.id },
        job,
        await s.shops.jobs.rows(s.h.merchant.id, job.id),
      ),
      requesterEmail: null,
      baseUrl: "https://agentify.ad/dashboard",
      idempotencyKey: "one",
    });
    const results = s.shops.recordedAnalytics
      .map(({ event }) => event)
      .filter((event) => event.name === "agc_setup_result");
    return {
      job,
      screen: [view?.words.outcome, view?.words.emptyOutcome].join(" "),
      subject: mail.subject,
      body: mail.body,
      reason: results.at(-1)?.fields,
    };
  };
  const ourSide = (said: Awaited<ReturnType<typeof told>>) => {
    expect(said.job.read).toBe(0);
    expect(said.screen).toContain("Agentify stopped on its side before reading your shop.");
    expect(said.screen).toContain("Nothing was published.");
    expect(said.screen).not.toContain("couldn't read");
    expect(said.subject).toBe("You're approved. Publishing stopped on our side");
    expect(said.body).toContain(
      "Agentify stopped on its side before reading woo.nuanu.ai. Nothing was published.",
    );
    expect(said.body).not.toContain("couldn't read");
    expect(said.reason).toMatchObject({ outcome: "unknown", reason_code: "unknown" });
  };
  /** A publication may have reached the gateway before its row was recorded. */
  const ourSideMidway = (said: Awaited<ReturnType<typeof told>>) => {
    expect(said.job.read).toBe(0);
    expect(said.screen).toContain(
      "Agentify stopped on its side. No product was confirmed on sale in this sync, and we don't know about the rest yet.",
    );
    expect(said.subject).toBe("You're approved. Publishing stopped on our side");
    expect(said.body).toContain(
      "Agentify stopped on its side while publishing from woo.nuanu.ai. No product was confirmed on sale, and we don't know about the rest yet.",
    );
    expect(said.body).toContain("Sync with your shop from your dashboard.");
    for (const words of [said.screen, said.body]) {
      expect(words).not.toContain("Nothing was published");
      expect(words).not.toContain("couldn't read");
    }
    expect(said.reason).toMatchObject({ outcome: "unknown", reason_code: "unknown" });
  };

  it("an unreadable seller account is told as Agentify's stop, not the shop's", async () => {
    const s = await setup([currency, item(11), complete]);
    await s.run("publish", {
      clientFor: (who) => ({
        ...gatewayFor(s.h.gateway, who),
        seller: async () => ({ ok: false, status: 0, why: "The gateway did not answer." }),
      }),
      catalogue: async function* () {
        yield await Promise.reject(new Error("The shop was asked after all"));
      },
    });
    ourSide(await told(s));
  });

  it("an unreadable seller account leaves one log line naming the gateway call", async () => {
    const s = await setup([currency, item(11), complete]);
    const lines: string[] = [];
    const log = vi.spyOn(console, "error").mockImplementation((...parts) => {
      lines.push(parts.join(" "));
    });
    try {
      await s.run("publish", {
        clientFor: (who) => ({
          ...gatewayFor(s.h.gateway, who),
          payoutWallet: async () => ({
            ok: false,
            status: 503,
            code: "unavailable",
            why: `The wallet of ${s.person.email} could not be read.`,
          }),
        }),
      });
    } finally {
      log.mockRestore();
    }
    expect(lines).toEqual([expect.stringMatching(/payoutWallet.*503 unavailable/)]);
    expect(lines.join("\n")).not.toContain(s.person.email);
  });

  it("a restart before the first product is told as Agentify's stop", async () => {
    const s = await setup([currency, item(11), complete]);
    await s.shops.noteCurrency(s.person.id, { code: "USD", decimals: 2 }, "grant-1");
    await s.shops.jobs.request({
      merchantId: s.h.merchant.id,
      accountId: s.person.id,
      connectionRevision: "grant-1",
      shopUrl: SHOP,
      kind: "publish",
      currency: { code: "USD", decimals: 2 },
      rate: null,
    });
    const job = await s.shops.jobs.claim();
    if (!job) throw new Error("The publication was not queued");
    await workShopJob(job, s.parts, () => true);
    const said = await told(s);
    expect(said.job.stopCode).toBe("interrupted");
    ourSideMidway(said);
  });

  it("an exception of Agentify's own before the first product is told as Agentify's stop", async () => {
    const s = await setup([currency, item(11), complete]);
    await s.shops.noteCurrency(s.person.id, { code: "USD", decimals: 2 }, "grant-1");
    await s.shops.jobs.request({
      merchantId: s.h.merchant.id,
      accountId: s.person.id,
      connectionRevision: "grant-1",
      shopUrl: SHOP,
      kind: "publish",
      currency: { code: "USD", decimals: 2 },
      rate: null,
    });
    const worker = startShopJobs({
      ...s.parts,
      publisherFor: (who) => ({
        ...shopPublisherFor(s.h.gateway, who, s.shops),
        cards: async () => {
          throw new Error("The published products could not be read.");
        },
      }),
    });
    try {
      await vi.waitFor(async () =>
        expect((await s.shops.jobs.latest(s.h.merchant.id))[0]?.status).toBe("stopped"),
      );
    } finally {
      await worker.stop();
    }
    const said = await told(s);
    expect(said.job.stopCode).toBe("unknown");
    ourSideMidway(said);
  });

  it("a failure after the gateway accepted the first product never says nothing was published", async () => {
    const s = await setup([currency, item(11), complete]);
    await s.shops.noteCurrency(s.person.id, { code: "USD", decimals: 2 }, "grant-1");
    await s.shops.jobs.request({
      merchantId: s.h.merchant.id,
      accountId: s.person.id,
      connectionRevision: "grant-1",
      shopUrl: SHOP,
      kind: "publish",
      currency: { code: "USD", decimals: 2 },
      rate: null,
    });
    const worker = startShopJobs({
      ...s.parts,
      publisherFor: (who) => ({
        ...shopPublisherFor(s.h.gateway, who, s.shops),
        read: async () => {
          throw new Error("The published card could not be read back.");
        },
      }),
    });
    try {
      await vi.waitFor(async () =>
        expect((await s.shops.jobs.latest(s.h.merchant.id))[0]?.status).toBe("stopped"),
      );
    } finally {
      await worker.stop();
    }
    expect(await s.h.store.cards(s.h.merchant.id)).toMatchObject([{ paused: false }]);
    const said = await told(s);
    expect(said.job.stopCode).toBe("unknown");
    ourSideMidway(said);
  });

  it("a check stopped by a restart before its first product says the same about the check", async () => {
    const s = await setup([currency, item(11), complete]);
    await s.shops.jobs.request({
      merchantId: s.h.merchant.id,
      accountId: s.person.id,
      connectionRevision: "grant-1",
      shopUrl: SHOP,
      kind: "check",
    });
    const job = await s.shops.jobs.claim();
    if (!job) throw new Error("The check was not queued");
    await workShopJob(job, s.parts, () => true);
    const view = await shopJobView(s.shops, s.h.merchant.id, new URLSearchParams());
    expect(view?.words.outcome).toBe("Agentify stopped on its side before the check finished.");
  });

  it("a shop that could not be read is still told as the shop's", async () => {
    const s = await setup([
      { kind: "stopped", why: "We couldn't read the rest of your shop.", reconnect: false },
    ]);
    await s.run("publish");
    const said = await told(s);
    expect(said.screen).toContain("We couldn't read woo.nuanu.ai.");
    expect(said.subject).toBe("You're approved. We couldn't read your shop");
    expect(said.reason).toMatchObject({ reason_code: "catalogue_unavailable" });
  });
});
