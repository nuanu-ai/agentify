import { fileURLToPath } from "node:url";
import { Gateway, PostgresStore } from "@agentify/gateway";
import { countedIds, type Harness, harness, serve } from "@agentify/gateway/testing";
import { readyDatabase, testDatabaseUrl } from "@agentify/gateway/testing/database";
import { CardSchema } from "@nuanu-ai/agentify-contracts";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { migrateAccounts } from "./database.js";
import { gatewayFor } from "./gateway.js";
import { shopPublisherFor } from "./shop-job-runner.js";
import { cardsFromTheShop, type StoreProduct } from "./woo-catalog.js";
import { postgresWooShops } from "./woo-shops.js";

const databaseUrl = await readyDatabase(testDatabaseUrl());
if (databaseUrl === null)
  throw new Error("The connector pause database proof needs its disposable PostgreSQL.");
const pool = new Pool({ connectionString: databaseUrl, max: 10 });
let h: Harness;
let gateway: Gateway;
let itemId: string;
let merchantId: string;
const acting = () => ({ merchantId, email: "owner@example.com" });
const shops = () =>
  postgresWooShops(pool, "connector-pause-proof-secret-at-least-thirty-two-bytes");

beforeAll(async () => {
  await pool.query("drop schema public cascade");
  await pool.query("create schema public");
  await pool.query("drop schema if exists drizzle cascade");
  await migrate(drizzle(pool), {
    migrationsFolder: fileURLToPath(new URL("../../gateway/drizzle", import.meta.url)),
  });
  await migrateAccounts(pool, fileURLToPath(new URL("../drizzle", import.meta.url)));
  h = await harness();
  merchantId = h.merchant.id;
  const store = PostgresStore.over(drizzle(pool), "eip155:84532", countedIds());
  await store.addMerchant({ id: merchantId, name: "Shop" }, h.now());
  gateway = new Gateway({ ...h.gateway.runtime, store });
  const product: StoreProduct = {
    id: 11,
    name: "Guide",
    sku: "guide",
    description: "A downloadable guide.",
    short_description: "",
    is_purchasable: true,
    is_in_stock: true,
    status: "publish",
    type: "simple",
    virtual: true,
    downloadable: true,
    manage_stock: false,
    download_limit: -1,
    download_expiry: -1,
    downloads: [{ id: "guide", name: "Guide", file: "https://woo.nuanu.ai/guide.pdf" }],
    qualification_problem: null,
    prices: { price: "2500", currency_code: "USD", currency_minor_unit: 2 },
  };
  const card = cardsFromTheShop([product], "https://woo.nuanu.ai").cards[0]?.card;
  if (!card) throw new Error("The published product fixture is invalid.");
  const stored = await store.publishCard(
    merchantId,
    CardSchema.parse(card),
    h.now(),
    "woocommerce",
  );
  itemId = stored.id;
});
afterAll(async () => {
  await h?.stop();
  await pool.end();
});

beforeEach(async () => {
  await gateway.runtime.store.setCardPaused(merchantId, itemId, false);
  await pool.query("truncate commerce_analytics_events");
});

describe("connector pause ownership across dashboard processes", () => {
  it.each([
    [
      "missing",
      "insert into dashboard_woo_card_pauses (merchant_id,item_id,paused_at) values ($1,$2,now())",
      { code: "23502", column: "reason" },
    ],
    [
      "unknown",
      "insert into dashboard_woo_card_pauses (merchant_id,item_id,paused_at,reason) values ($1,$2,now(),'unknown')",
      { code: "23514", constraint: "dashboard_woo_card_pause_reason" },
    ],
  ] as const)(
    "rejects a %s withdrawal reason at the storage boundary",
    async (_name, query, failure) => {
      await expect(pool.query(query, [merchantId, itemId])).rejects.toMatchObject(failure);
    },
  );
  it.each(["stopped_selling", "changed"] as const)(
    "persists %s across a new publisher and returns the same card to sale",
    async (reason) => {
      const first = shops();
      await shopPublisherFor(gateway, acting(), first).pause(itemId, reason);
      const prior = await gateway.runtime.store.cardById(itemId);
      if (!prior) throw new Error("The card is missing.");
      await gateway.runtime.store.publishCard(
        merchantId,
        { ...prior.card, description: "An updated guide." },
        h.now(),
        "woocommerce",
      );
      const restarted = shops();
      expect(
        await gatewayFor(gateway, acting(), undefined, restarted.cardPauses).cards(),
      ).toMatchObject({
        ok: true,
        document: { integrationPauses: { [itemId]: { at: expect.any(Number), reason } } },
      });
      await shopPublisherFor(gateway, acting(), restarted).pause(itemId, null);
      expect(await gateway.runtime.store.cardById(itemId)).toMatchObject({ paused: false });
      expect(await restarted.cardPauses.list(merchantId)).toEqual({});
    },
  );
  it("refreshes an owned pause's reason without restarting its clock or introducing connector analytics", async () => {
    await shopPublisherFor(gateway, acting(), shops()).pause(itemId, "stopped_selling");
    const first = (await shops().cardPauses.list(merchantId))[itemId];
    await shopPublisherFor(gateway, acting(), shops()).pause(itemId, "changed");
    expect((await shops().cardPauses.list(merchantId))[itemId]).toEqual({
      at: first?.at,
      reason: "changed",
    });
    expect(
      (
        await pool.query(
          "select name from commerce_analytics_events where name='agc_selling_changed'",
        )
      ).rowCount,
    ).toBe(0);
  });
  it("a redundant ordinary API pause takes ownership from the connector", async () => {
    await shopPublisherFor(gateway, acting(), shops()).pause(itemId, "stopped_selling");
    const key = await gateway.issueMerchantKey(merchantId, "Seller code", {
      kind: "signed_in",
      email: acting().email,
    });
    const api = await serve({ gateway });
    try {
      expect(
        await api.call("POST", `/v0/cards/${itemId}/pause`, {
          headers: { authorization: `Bearer ${key.secret}` },
        }),
      ).toMatchObject({ status: 200 });
    } finally {
      await api.close();
    }
    await shopPublisherFor(gateway, acting(), shops()).pause(itemId, "changed");
    await shopPublisherFor(gateway, acting(), shops()).pause(itemId, null);
    expect(await gateway.runtime.store.cardById(itemId)).toMatchObject({ paused: true });
    expect(await shops().cardPauses.list(merchantId)).toEqual({});
    await gateway.setCardPaused(merchantId, itemId, false);
  });
  it("serializes a seller pause behind an in-flight connector pause and preserves the seller choice", async () => {
    const first = shops();
    const other = shops();
    const blocker = await pool.connect();
    await blocker.query("begin");
    await blocker.query("select id from cards where id=$1 for update", [itemId]);
    const withdrawing = shopPublisherFor(gateway, acting(), first).pause(itemId, "stopped_selling");
    try {
      await expect
        .poll(
          async () =>
            (
              await pool.query(
                "select 1 from pg_stat_activity where datname=current_database() and wait_event_type='Lock' and query like 'select paused from cards%'",
              )
            ).rowCount,
        )
        .toBe(1);
      const seller = gatewayFor(gateway, acting(), undefined, other.cardPauses).pauseCard(
        itemId,
        true,
      );
      await blocker.query("commit");
      await withdrawing;
      expect(await seller).toMatchObject({ ok: true });
    } finally {
      await blocker.query("rollback");
      blocker.release();
    }
    await shopPublisherFor(gateway, acting(), shops()).pause(itemId, "changed");
    await shopPublisherFor(gateway, acting(), shops()).pause(itemId, null);
    expect(await gateway.runtime.store.cardById(itemId)).toMatchObject({ paused: true });
    expect(await shops().cardPauses.list(merchantId)).toEqual({});
    const transitions = await pool.query(
      "select actor_type, source, properties->>'change' as change from commerce_analytics_events where name='agc_selling_changed' order by sequence",
    );
    expect(transitions.rows).toEqual([]);
  });
  it("rolls back the card pause and ownership together when commit fails", async () => {
    await pool.query(
      "create function refuse_pause_commit() returns trigger language plpgsql as $$ begin raise exception 'pause commit refused'; end $$",
    );
    await pool.query(
      "create constraint trigger refuse_pause_commit after update on cards deferrable initially deferred for each row execute function refuse_pause_commit()",
    );
    try {
      await expect(
        shopPublisherFor(gateway, acting(), shops()).pause(itemId, "stopped_selling"),
      ).rejects.toThrow();
      expect(await gateway.runtime.store.cardById(itemId)).toMatchObject({ paused: false });
      expect(await shops().cardPauses.list(merchantId)).toEqual({});
      expect((await pool.query("select name from commerce_analytics_events")).rows).toEqual([]);
    } finally {
      await pool.query("drop trigger refuse_pause_commit on cards");
      await pool.query("drop function refuse_pause_commit()");
    }
  });
});
