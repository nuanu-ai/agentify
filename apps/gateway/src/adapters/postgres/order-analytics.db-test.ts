import { storeAcceptedOrder } from "../../testing/accepted-order.js";
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
import { OrderRunner } from "../../app/runner.js";
import type { Integration, StoredOrder } from "../../ports/store.js";
import { noDatabaseHere, readyDatabase, testDatabaseUrl } from "../../testing/database.js";
import {
  buyOverHttp,
  countedIds,
  harness,
  loggedWhile,
  serve,
  signedFor,
} from "../../testing/harness.js";
import { aWallet } from "../../testing/signed-payment.js";
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

const unfulfilled = (order: StoredOrder): AnalyticsEvent => ({
  name: "agc_order_outcome_changed",
  actor: "system",
  source: "gateway",
  refs: { order: order.order.id, merchant: order.merchantId },
  fields: { outcome: "unfulfilled", payment_state: "paid", money_mode: "test" },
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
      "truncate table cards, orders, receipts, payment_claims, merchant_keys, merchant_contact, merchants, payout_splits, commerce_analytics_events",
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

  // A real accepted purchase supplies the history restored into each isolated database case.
  const ids = countedIds();
  const original = await harness({}, { ids: (kind) => (kind === "mch" ? MERCHANT : ids(kind)) });
  let acceptedHistory: StoredOrder;
  try {
    const published = await original.gateway.publishCard(MERCHANT, {
      merchant_item_id: "analytics-history",
      title: "A digital guide",
      description: "A digital guide delivered after payment",
      price: { amount: "5.00", currency: "USD" },
      result: { access_url: { type: "string" } },
      fulfillment: "async",
      fulfill_deadline_seconds: 3600,
    });
    if (!published.ok) throw new Error("The analytics history card was refused.");
    const offer = await original.gateway.beginPurchase(published.id, {});
    if (offer.step !== "pay") throw new Error("The analytics history was not priced.");
    const signed = await signedFor(original, offer.order, aWallet("the analytics history buyer"), {
      nonce: "0x01",
    });
    await original.gateway.payPurchase(
      offer.order.priceOffer.stamp,
      signed.payment,
      signed.fingerprint,
      undefined,
      { itemId: published.id, params: {} },
    );
    const accepted = await original.store.orderById(offer.order.order.id);
    if (accepted?.paidBy === null || accepted === null || accepted.order.state !== "paid")
      throw new Error("The analytics history was not paid.");
    acceptedHistory = accepted;
  } finally {
    await original.stop();
  }
  const ORDER = acceptedHistory.order.id;
  const CREATED_AT = Date.parse("2026-08-26T12:00:00.000Z");
  const anOrderOf = (): StoredOrder => structuredClone(acceptedHistory);
  const admitWithCreationEvent = async (order: StoredOrder, through: Integration = "api") => {
    const fingerprint = order.paymentFingerprint;
    if (fingerprint === undefined) throw new Error("The accepted history has no verified payment.");
    const admitted = await store.admitOrder({
      record: order,
      standing: () => "stands",
      birth: { through },
      fingerprint,
      alongside: [],
      analytics: [{ event: created(order), at: CREATED_AT }],
    });
    return admitted.kind === "admitted"
      ? "written"
      : admitted.kind === "existing"
        ? "exists"
        : admitted.kind;
  };

  describe("the birth of an order", () => {
    it("records its event in the insert's transaction, dated when the order was made", async () => {
      const order = anOrderOf();

      expect(await admitWithCreationEvent(order)).toBe("written");

      expect(await outbox()).toStrictEqual([
        {
          name: "agc_order_created",
          occurred_at: new Date(CREATED_AT),
          actor_type: "buyer_agent",
          refs: { order: ORDER, merchant: MERCHANT, item: acceptedHistory.itemId },
          properties: { integration: "api", money_mode: "test", network: "base_sepolia" },
        },
      ]);
    });

    it("records nothing when the merchant no longer sells through the order's integration", async () => {
      const order = anOrderOf();

      expect(await admitWithCreationEvent(order, "woocommerce")).toBe("off_sale");

      expect(await outbox()).toStrictEqual([]);
    });

    it("records nothing for an order that is already written down", async () => {
      const order = anOrderOf();
      await admitWithCreationEvent(order);

      await expect(admitWithCreationEvent(order)).resolves.toBe("exists");

      expect(await outbox()).toHaveLength(1);
    });
  });

  describe("a change to an order", () => {
    it("records what the change amounts to, read off the order as found and as saved", async () => {
      const order = anOrderOf();
      await storeAcceptedOrder(store, order);
      const seen: string[] = [];

      await store.withOrder(
        ORDER,
        (found) => ({
          save: { ...found, order: { ...found.order, state: "unfulfilled" } },
          result: 1,
        }),
        undefined,
        (before, after) => {
          seen.push(`${before.order.state} -> ${after.order.state}`);
          return [{ event: unfulfilled(after), at: CREATED_AT + 2_000 }];
        },
      );

      expect(seen).toStrictEqual(["paid -> unfulfilled"]);
      expect(await outbox()).toMatchObject([
        { name: "agc_order_outcome_changed", occurred_at: new Date(CREATED_AT + 2_000) },
      ]);
    });

    it("asks for nothing when the change saves nothing", async () => {
      await storeAcceptedOrder(store, anOrderOf());
      let asked = 0;

      await store.withOrder(
        ORDER,
        () => ({ result: 1 }),
        undefined,
        (_before, after) => {
          asked += 1;
          return [{ event: unfulfilled(after), at: CREATED_AT + 2_000 }];
        },
      );

      expect(asked).toBe(0);
      expect(await outbox()).toStrictEqual([]);
    });

    it("records nothing when the change's own writes roll back", async () => {
      await storeAcceptedOrder(store, anOrderOf());

      await expect(
        store.withOrder(
          ORDER,
          (found) => ({
            save: { ...found, order: { ...found.order, state: "unfulfilled" } },
            alongside: [{ kind: "retain_payment", fingerprint: "nobody's", orderId: ORDER }],
            result: 1,
          }),
          undefined,
          (_before, after) => [{ event: unfulfilled(after), at: CREATED_AT + 2_000 }],
        ),
      ).rejects.toThrow("the payment claim no longer belongs to this order");

      expect(await outbox()).toStrictEqual([]);
      expect((await store.orderById(ORDER))?.order.state).toBe("paid");
    });
  });

  describe("an outbox that cannot take the event", () => {
    const awayWhile = async (during: () => Promise<void>): Promise<string> => {
      await pool.query(
        "alter table commerce_analytics_events rename to commerce_analytics_events_away",
      );
      try {
        return await loggedWhile(during);
      } finally {
        await pool.query(
          "alter table commerce_analytics_events_away rename to commerce_analytics_events",
        );
      }
    };

    it("still writes the order a purchase made, and says so without naming it", async () => {
      const order = anOrderOf();

      const said = await awayWhile(async () => {
        expect(await admitWithCreationEvent(order)).toBe("written");
      });

      expect((await store.orderById(ORDER))?.order.state).toBe("paid");
      expect(said).toMatch(/analytics event could not be recorded/);
      expect(said).not.toContain(ORDER);
    });

    it("completes an actual unresolved payment and writes its receipt while the analytics outbox is unavailable", async () => {
      const running = await harness({ SETTLE_RESPONSE_MS: "40" });
      const served = await serve(running);
      try {
        const published = await running.gateway.publishCard(running.merchant.id, {
          merchant_item_id: "recoverable",
          title: "Held goods",
          description: "Goods released after payment confirmation",
          price: { amount: "5.00", currency: "USD" },
          result: { code: { type: "string" } },
          fulfillment: "sync",
        });
        if (!published.ok) throw new Error("the card was refused");
        running.facilitator.willSettle({
          settled: "unknown",
          reason: "connection ended before the reply",
        });
        await buyOverHttp(running, served, published.id, {
          onOrder: () => ({ delivered: { code: "PAID-GOODS" } }),
        });
        const [submitted] = await running.gateway.orders(running.merchant.id, undefined);
        if (!submitted?.paymentAttempt) throw new Error("no actual payment attempt was submitted");
        expect(submitted.order.payment).toBe("outcome_unknown");
        // Restore the genuine unresolved purchase into this database, then run its completion owner.
        await store.addMerchant(
          { id: running.merchant.id, name: "Restored merchant" },
          running.now(),
        );
        await storeAcceptedOrder(store, submitted);
        const runner = new OrderRunner({ ...running.runtime, store });
        const attemptId = submitted.paymentAttempt.id;
        const transaction = `0x${"ab".repeat(32)}`;
        const said = await awayWhile(async () => {
          await runner.completePaymentAttempt(
            submitted.order.id,
            attemptId,
            {
              settled: true,
              transaction,
              executedAt: running.now(),
            },
            "chain",
          );
        });
        const after = await store.orderById(submitted.order.id);
        expect(after).toMatchObject({
          order: { state: "delivered", payment: "settled" },
          delivery: { code: "PAID-GOODS" },
          paymentAttempt: { completion: { settled: true, transaction, source: "chain" } },
        });
        expect(await store.receipts(running.merchant.id)).toMatchObject([
          {
            order_id: submitted.order.id,
            outcome: "delivered",
            price: { amount: "5.00", currency: "USD" },
          },
        ]);
        expect(said).toMatch(/analytics.*recorded/);
      } finally {
        await served.close();
        await running.stop();
      }
    });
  });
}
