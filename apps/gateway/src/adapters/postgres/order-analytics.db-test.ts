/**
 * The analytics the Postgres store records with an order's own writes: the
 * order's birth in the transaction that inserts it, and what a change to it
 * amounts to in the transaction that saves the change. Against PostgreSQL,
 * because what is promised is the database's: the event commits with the
 * write or not at all.
 */

import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { AnalyticsEvent, OrderCreated } from "../../analytics/index.js";
import type { StoredOrder } from "../../ports/store.js";
import { noDatabaseHere, readyDatabase, testDatabaseUrl } from "../../testing/database.js";
import { countedIds } from "../../testing/harness.js";
import { anOrder } from "../../testing/store-contract.js";
import { connect, PostgresStore } from "./store.js";

const wanted = (() => {
  const url = new URL(testDatabaseUrl());
  url.pathname = "/agentify_test_order_analytics";
  return url.toString();
})();
const databaseUrl = await readyDatabase(wanted);
const migrationsIn = join(
  fileURLToPath(new URL(".", import.meta.url)),
  "..",
  "..",
  "..",
  "drizzle",
);

const MERCHANT = "mch_analytics";

const created = (order: StoredOrder): OrderCreated => ({
  name: "agc_order_created",
  actor: "buyer_agent",
  source: "gateway",
  refs: { order: order.order.id, merchant: order.merchantId, item: order.itemId },
  fields: { integration: "api", money_mode: "test", network: "base_sepolia" },
});

const expired = (order: StoredOrder): AnalyticsEvent => ({
  name: "agc_order_outcome_changed",
  actor: "system",
  source: "gateway",
  refs: { order: order.order.id, merchant: order.merchantId },
  fields: { outcome: "expired", payment_state: "not_paid", money_mode: "test" },
});

if (databaseUrl === null) {
  console.log(noDatabaseHere(wanted));
  describe("the analytics an order's writes record", () => {
    it.skip("is skipped: there is no PostgreSQL to run it against", () => {});
  });
} else {
  const { db, pool } = connect(databaseUrl, { max: 4 });
  await pool.query("drop schema public cascade");
  await pool.query("create schema public");
  await pool.query("drop schema if exists drizzle cascade");
  await migrate(drizzle(pool), { migrationsFolder: migrationsIn });

  afterAll(async () => {
    await pool.end();
  });

  let store: PostgresStore;
  beforeEach(async () => {
    await pool.query(
      "truncate table cards, orders, receipts, payment_claims, merchant_keys, merchants, payout_splits, commerce_analytics_events",
    );
    store = PostgresStore.over(db, "eip155:84532", countedIds());
    await store.addMerchant({ id: MERCHANT, name: "The merchant" }, 1_000);
  });

  const outbox = async () =>
    (
      await pool.query<{
        name: string;
        occurred_at: Date;
        actor_type: string;
        refs: unknown;
        properties: unknown;
      }>(
        "select name, occurred_at, actor_type, refs, properties from commerce_analytics_events order by sequence",
      )
    ).rows;

  const anOrderOf = (id: string): StoredOrder => ({
    ...anOrder(id, "quoted", { merchantId: MERCHANT, createdAt: 5_000 }),
    itemId: "item_1",
  });

  describe("the birth of an order", () => {
    it("records its event in the insert's transaction, dated when the order was made", async () => {
      const order = anOrderOf("ord_1");

      expect(await store.addOrder(order, "api", created(order))).toBe(true);

      expect(await outbox()).toStrictEqual([
        {
          name: "agc_order_created",
          occurred_at: new Date(5_000),
          actor_type: "buyer_agent",
          refs: { order: "ord_1", merchant: MERCHANT, item: "item_1" },
          properties: { integration: "api", money_mode: "test", network: "base_sepolia" },
        },
      ]);
    });

    it("records nothing when the merchant no longer sells through the order's integration", async () => {
      const order = anOrderOf("ord_1");

      expect(await store.addOrder(order, "woocommerce", created(order))).toBe(false);

      expect(await outbox()).toStrictEqual([]);
    });

    it("records nothing for an order that is already written down", async () => {
      const order = anOrderOf("ord_1");
      await store.addOrder(order, "api", created(order));

      await expect(store.addOrder(order, "api", created(order))).rejects.toThrow(
        "already written down",
      );

      expect(await outbox()).toHaveLength(1);
    });
  });

  describe("a change to an order", () => {
    it("records what the change amounts to, read off the order as found and as saved", async () => {
      const order = anOrderOf("ord_1");
      await store.addOrder(order);
      const seen: string[] = [];

      await store.withOrder(
        "ord_1",
        (found) => ({ save: { ...found, order: { ...found.order, state: "expired" } }, result: 1 }),
        undefined,
        (before, after) => {
          seen.push(`${before.order.state} -> ${after.order.state}`);
          return [{ event: expired(after), at: 7_000 }];
        },
      );

      expect(seen).toStrictEqual(["quoted -> expired"]);
      expect(await outbox()).toMatchObject([
        { name: "agc_order_outcome_changed", occurred_at: new Date(7_000) },
      ]);
    });

    it("asks for nothing when the change saves nothing", async () => {
      await store.addOrder(anOrderOf("ord_1"));
      let asked = 0;

      await store.withOrder(
        "ord_1",
        () => ({ result: 1 }),
        undefined,
        (_before, after) => {
          asked += 1;
          return [{ event: expired(after), at: 7_000 }];
        },
      );

      expect(asked).toBe(0);
      expect(await outbox()).toStrictEqual([]);
    });

    it("records nothing when the change's own writes roll back", async () => {
      await store.addOrder(anOrderOf("ord_1"));

      await expect(
        store.withOrder(
          "ord_1",
          (found) => ({
            save: { ...found, order: { ...found.order, state: "expired" } },
            alongside: [{ kind: "retain_payment", fingerprint: "nobody's", orderId: "ord_1" }],
            result: 1,
          }),
          undefined,
          (_before, after) => [{ event: expired(after), at: 7_000 }],
        ),
      ).rejects.toThrow("the payment claim no longer belongs to this order");

      expect(await outbox()).toStrictEqual([]);
      expect((await store.orderById("ord_1"))?.order.state).toBe("quoted");
    });
  });
}
