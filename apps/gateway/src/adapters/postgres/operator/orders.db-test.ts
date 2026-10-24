/**
 * The operator's orders reads on PostgreSQL: the contract the memory reader
 * runs under `pnpm test`, over rows the Postgres store wrote, and what only a
 * database can show: a read that fails reaches the caller as a failure,
 * never as an empty list or a zero, and without the values it was asked for.
 */

import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ORDER_STATES } from "@agentify/core";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import {
  deliveredNotPaid,
  endedOrder,
  inProgress,
  paymentUnknown,
  unfulfilledOrder,
} from "../../../ports/operator/orders.js";
import { lapsedAttempt, type StoredOrder } from "../../../ports/store.js";
import { noDatabaseHere, readyDatabase, testDatabaseUrl } from "../../../testing/database.js";
import { countedIds } from "../../../testing/harness.js";
import { describeOperatorOrders } from "../../../testing/operator-orders-contract.js";
import { anOrder } from "../../../testing/store-contract.js";
import { orders } from "../schema.js";
import { connect, PostgresStore } from "../store.js";
import { postgresOperatorReader } from "./index.js";
import {
  DELIVERED_NOT_PAID,
  ENDED,
  IN_PROGRESS,
  LAPSED,
  PAYMENT_UNKNOWN,
  UNFULFILLED,
} from "./predicates.js";
import { readOnlyOn } from "./read-only.js";

const PAYMENT_STAGES = [
  "none",
  "verified",
  "settling",
  "outcome_unknown",
  "settled",
  "settle_failed",
] as const;

const wanted = (() => {
  const url = new URL(testDatabaseUrl());
  url.pathname = "/agentify_test_operator_orders";
  return url.toString();
})();
const databaseUrl = await readyDatabase(wanted);
const migrationsIn = join(
  fileURLToPath(new URL(".", import.meta.url)),
  "..",
  "..",
  "..",
  "..",
  "drizzle",
);

const EMPTY_EVERY_TABLE =
  "truncate table cards, orders, receipts, payment_claims, merchant_keys, merchant_contact, merchants," +
  " payout_splits, commerce_analytics_events, operator_journal";

if (databaseUrl === null) {
  console.log(noDatabaseHere(wanted));
  describe("the operator's orders on a real database", () => {
    it.skip("is skipped: there is no PostgreSQL to run it against", () => {});
  });
} else {
  const migrating = new Pool({ connectionString: databaseUrl });
  await migrating.query("drop schema public cascade");
  await migrating.query("create schema public");
  await migrating.query("drop schema if exists drizzle cascade");
  await migrate(drizzle(migrating), { migrationsFolder: migrationsIn });
  await migrating.end();

  const { db, pool } = connect(databaseUrl);

  afterAll(async () => {
    await pool.end();
  });

  describeOperatorOrders("the operator's orders on Postgres", async () => {
    // The registry of splits refuses a delete; only a truncate empties it.
    await pool.query(EMPTY_EVERY_TABLE);
    return {
      store: PostgresStore.over(db, "eip155:84532", countedIds()),
      orders: postgresOperatorReader(db, "eip155:84532").orders,
    };
  });

  describe("the segments' predicates", () => {
    it("hold each order exactly where their memory twins do, in every state and payment stage", async () => {
      await pool.query(EMPTY_EVERY_TABLE);
      const store = PostgresStore.over(db, "eip155:84532", countedIds());
      await store.addMerchant({ id: "mch_twins", name: "A merchant" }, 1);
      const written: StoredOrder[] = [];
      for (const state of ORDER_STATES) {
        for (const payment of PAYMENT_STAGES) {
          const base = anOrder(`ord_${state}_${payment}`, state, { merchantId: "mch_twins" });
          const record = { ...base, order: { ...base.order, payment } };
          await store.addOrder(record);
          written.push(record);
        }
      }
      const twins = {
        payment_unknown: [PAYMENT_UNKNOWN, paymentUnknown],
        unfulfilled: [UNFULFILLED, unfulfilledOrder],
        delivered_unpaid: [DELIVERED_NOT_PAID, deliveredNotPaid],
        in_progress: [IN_PROGRESS, inProgress],
        ended: [ENDED, endedOrder],
        lapsed: [LAPSED, lapsedAttempt],
      } as const;
      const read = readOnlyOn(db);

      for (const [segment, [predicate, twin]] of Object.entries(twins)) {
        const held = await read(
          async (tx) => await tx.select({ id: orders.id }).from(orders).where(predicate),
        );
        const expected = written.filter((record) => twin(record)).map((record) => record.order.id);
        expect(held.map((row) => row.id).sort(), segment).toStrictEqual(expected.sort());
        expect(expected.length, segment).toBeGreaterThan(0);
      }
    });
  });

  describe("a read of the operator's orders that fails", () => {
    it("reaches the caller as a failure carrying none of the values it was asked for", async () => {
      const closed = connect(databaseUrl);
      await closed.pool.end();
      const orders = postgresOperatorReader(closed.db, "eip155:84532").orders;

      for (const read of [
        orders.orders({ shown: "all", search: "a searched secret" }),
        orders.order("ord_a_secret_identifier"),
        orders.find("ord_a_secret_identifier", 0),
      ]) {
        const thrown = await read.then(
          () => null,
          (failure: unknown) => failure,
        );
        expect(thrown).toBeInstanceOf(Error);
        expect(JSON.stringify(thrown) + String(thrown)).not.toMatch(/secret/);
      }
    });
  });
}
