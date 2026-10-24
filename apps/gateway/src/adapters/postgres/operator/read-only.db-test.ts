/**
 * The operator's reads against PostgreSQL, for what only the database can
 * show: a read cannot write, whatever it sends; it sees one moment of the
 * database, so its count and its rows agree; a read that runs too long is
 * cut off; the bound leaves with the transaction rather than staying on a
 * pooled connection; and the payment-unknown predicate the overview and the
 * orders share agrees with its memory twin and reads through its index.
 */

import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { count, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { paymentUnknown } from "../../../ports/operator/orders.js";
import type { StoredOrder } from "../../../ports/store.js";
import { noDatabaseHere, readyDatabase, testDatabaseUrl } from "../../../testing/database.js";
import { merchants, orders } from "../schema.js";
import { connect } from "../store.js";
import { PAYMENT_UNKNOWN } from "./predicates.js";
import { readOnlyOn } from "./read-only.js";

const wanted = (() => {
  const url = new URL(testDatabaseUrl());
  url.pathname = "/agentify_test_operator_reads";
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

/** Every payment stage an order's record can hold, as the order machine lists them. */
const PAYMENTS = [
  "none",
  "verified",
  "settling",
  "outcome_unknown",
  "settled",
  "settle_failed",
] as const;

if (databaseUrl === null) {
  console.log(noDatabaseHere(wanted));
  describe("the operator's reads on a real database", () => {
    it.skip("is skipped: there is no PostgreSQL to run it against", () => {});
  });
} else {
  const migrating = new Pool({ connectionString: databaseUrl });
  await migrating.query("drop schema public cascade");
  await migrating.query("create schema public");
  await migrating.query("drop schema if exists drizzle cascade");
  await migrate(drizzle(migrating), { migrationsFolder: migrationsIn });
  await migrating.end();

  // One connection, so a bound left behind would be met by the next read.
  const { db, pool } = connect(databaseUrl, { max: 1 });

  beforeEach(async () => {
    await pool.query("truncate table orders, merchants cascade");
    await pool.query(
      "insert into merchants (id, name, selling, created_at, updated_at) values ('mch_read', 'A merchant', 'open', now(), now())",
    );
  });

  afterAll(async () => {
    await pool.end();
  });

  describe("the operator's reads on a real database", () => {
    it("reads, and refuses any write a read sends, writing nothing", async () => {
      const read = readOnlyOn(db);

      expect(
        await read(async (tx) => (await tx.select({ n: count() }).from(merchants))[0]?.n),
      ).toBe(1);
      await expect(
        read(async (tx) => await tx.execute(sql`delete from merchants`)),
      ).rejects.toMatchObject({ cause: { code: "25006" } });
      // Postgres lets a transaction's mode change until its first query; a
      // read that asks for writing first must still not write.
      await expect(
        read(async (tx) => {
          await tx.execute(sql`set transaction read write`);
          await tx.execute(sql`delete from merchants`);
        }),
      ).rejects.toThrow();

      expect((await pool.query("select count(*)::int as n from merchants")).rows[0]?.n).toBe(1);
    });

    it("sees one moment of the database, so a count and the rows it counts agree", async () => {
      const read = readOnlyOn(db);
      const elsewhere = new Pool({ connectionString: databaseUrl, max: 1 });
      try {
        const seen = await read(async (tx) => {
          const before = (await tx.select({ n: count() }).from(merchants))[0]?.n;
          await elsewhere.query(
            "insert into merchants (id, name, selling, created_at, updated_at) values ('mch_meanwhile', 'Another merchant', 'open', now(), now())",
          );
          const after = (await tx.select({ n: count() }).from(merchants))[0]?.n;
          return { before, after };
        });

        expect(seen).toStrictEqual({ before: 1, after: 1 });
      } finally {
        await elsewhere.end();
      }
    });

    it("cuts off a read that runs past its bound, and leaves no bound on the connection", async () => {
      const read = readOnlyOn(db, 100);

      await expect(
        read(async (tx) => await tx.execute(sql`select pg_sleep(2)`)),
      ).rejects.toMatchObject({ cause: { code: "57014" } });

      const shown = await pool.query("show statement_timeout");
      expect(shown.rows[0]?.statement_timeout).toBe("0");
    });

    it("refuses a bound that is no bound", () => {
      for (const bound of [0, -1, 1.5, Number.NaN]) {
        expect(() => readOnlyOn(db, bound), String(bound)).toThrow();
      }
    });

    it("counts a payment as unknown exactly where its memory twin does, through the orders' partial index", async () => {
      for (const [at, payment] of PAYMENTS.entries()) {
        await pool.query(
          "insert into orders (id, state, open, merchant_id, item_id, merchant_item_id, record, created_at, updated_at) values ($1, 'paid', true, 'mch_read', 'itm_1', 'sku-1', $2, now(), now())",
          [`ord_${at}`, JSON.stringify({ order: { id: `ord_${at}`, payment } })],
        );
      }
      const read = readOnlyOn(db);

      const counted = await read(
        async (tx) => (await tx.select({ n: count() }).from(orders).where(PAYMENT_UNKNOWN))[0]?.n,
      );
      const twin = PAYMENTS.filter((payment) =>
        paymentUnknown({ order: { payment } } as unknown as StoredOrder),
      );
      expect(counted).toBe(twin.length);
      expect(twin).toStrictEqual(["settling", "outcome_unknown"]);

      const plan = await read(async (tx) => {
        await tx.execute(sql`set local enable_seqscan = off`);
        return await tx.execute(
          sql`explain select count(*) from ${orders} where ${PAYMENT_UNKNOWN}`,
        );
      });
      expect(JSON.stringify(plan.rows)).toContain("orders_unresolved_payment_idx");
    });
  });
}
