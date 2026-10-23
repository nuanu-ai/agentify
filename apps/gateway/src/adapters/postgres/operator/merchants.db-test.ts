/**
 * The operator's reads of merchants against PostgreSQL: the contract the
 * memory reader is held to, over the same rows written through the Postgres
 * store, and that a read the database cannot answer reaches the caller as a
 * failure, never as an empty channel.
 */

import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { noDatabaseHere, readyDatabase, testDatabaseUrl } from "../../../testing/database.js";
import { describeOperatorMerchants } from "../../../testing/operator-merchants-contract.js";
import { connect, PostgresStore } from "../store.js";
import { postgresOperatorReader } from "./index.js";

const wanted = (() => {
  const url = new URL(testDatabaseUrl());
  url.pathname = "/agentify_test_operator_merchants";
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
  describe("the operator's merchants on a real database", () => {
    it.skip("is skipped: there is no PostgreSQL to run it against", () => {});
  });
} else {
  const migrating = new Pool({ connectionString: databaseUrl });
  await migrating.query("drop schema public cascade");
  await migrating.query("create schema public");
  await migrating.query("drop schema if exists drizzle cascade");
  await migrate(drizzle(migrating), { migrationsFolder: migrationsIn });
  await migrating.end();

  const { db, pool } = connect(databaseUrl, { max: 4 });
  afterAll(async () => {
    await pool.end();
  });

  let issued = 0;
  const ids = (prefix: string): string => {
    issued += 1;
    return `${prefix}_${issued}`;
  };
  describeOperatorMerchants("the operator's merchants on Postgres", async () => {
    await pool.query(EMPTY_EVERY_TABLE);
    const store = PostgresStore.over(db, "eip155:84532", ids);
    return { store, merchants: postgresOperatorReader(db, "eip155:84532").merchants };
  });

  describe("the operator's merchants when the database cannot answer", () => {
    it("rejects each read rather than answering an empty channel", async () => {
      const closed = connect(databaseUrl, { max: 1 });
      await closed.pool.end();
      const merchants = postgresOperatorReader(closed.db, "eip155:84532").merchants;
      const at = { at: Date.UTC(2026, 9, 23), surface: "live" } as const;

      await expect(merchants.list({ ...at, limit: 50 })).rejects.toThrow();
      await expect(merchants.merchant("mch_a", at)).rejects.toThrow();
    });
  });
}
