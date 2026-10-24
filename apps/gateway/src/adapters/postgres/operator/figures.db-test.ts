/**
 * The operator's figures and splits against PostgreSQL: the contract both
 * readers keep, and what only a database can show. A read that fails reaches
 * its caller as a thrown error, never as a zero, and the outbox counts the
 * events its sender gave up or had refused, which only rows on disk hold.
 */

import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import type { FiguresAsked } from "../../../ports/operator/figures.js";
import { noDatabaseHere, readyDatabase, testDatabaseUrl } from "../../../testing/database.js";
import { countedIds } from "../../../testing/harness.js";
import { describeOperatorFigures } from "../../../testing/operator-figures-contract.js";
import { connect, PostgresStore } from "../store.js";
import { postgresOperatorReader } from "./index.js";

const NETWORK = "eip155:84532";
const NOW = Date.parse("2026-10-23T14:05:00.000Z");
const LIVE: FiguresAsked = { at: NOW, surface: "live" };

const wanted = (() => {
  const url = new URL(testDatabaseUrl());
  url.pathname = "/agentify_test_operator_figures";
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

if (databaseUrl === null) {
  console.log(noDatabaseHere(wanted));
  describe("the operator's figures on a real database", () => {
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

  /** Every table of the gateway's, emptied before each case, the registry of splits included. */
  const emptied = async (): Promise<void> => {
    const { rows } = await pool.query<{ name: string }>(
      "select quote_ident(tablename) as name from pg_tables where schemaname = 'public'",
    );
    await pool.query(`truncate table ${rows.map((row) => row.name).join(", ")} cascade`);
  };

  afterAll(async () => {
    await pool.end();
  });

  describeOperatorFigures("the operator's figures on Postgres", async () => {
    await emptied();
    return {
      store: PostgresStore.over(db, NETWORK, countedIds()),
      reader: postgresOperatorReader(db, NETWORK),
    };
  });

  describe("the operator's figures on Postgres, where a read fails", () => {
    it("throws from every read rather than answering a zero", async () => {
      // A page that met a zero here would tell the operator "there are none"
      // when the truth is "nobody knows".
      const closed = connect(databaseUrl);
      await closed.pool.end();
      const { figures, splits } = postgresOperatorReader(closed.db, NETWORK);

      const reads: [string, () => Promise<unknown>][] = [
        ["waitingForAdmission", () => figures.waitingForAdmission(LIVE)],
        ["unknownPayments", () => figures.unknownPayments(LIVE)],
        ["workers", () => figures.workers(LIVE)],
        ["analyticsOutbox", () => figures.analyticsOutbox(LIVE)],
        ["merchantCounts", () => figures.merchantCounts(LIVE)],
        ["recentOrders", () => figures.recentOrders(LIVE)],
        ["money", () => figures.money(LIVE, "30d")],
        ["salesByDay", () => figures.salesByDay(LIVE)],
        ["funnel", () => figures.funnel(LIVE, { merchantIds: [] })],
        ["splits", () => splits.splits(LIVE)],
      ];
      const answered: string[] = [];
      for (const [name, read] of reads) {
        try {
          await read();
          answered.push(name);
        } catch (thrown) {
          expect(thrown, name).toBeInstanceOf(Error);
        }
      }

      expect(answered).toStrictEqual([]);
    });
  });

  describe("the commerce analytics outbox on Postgres", () => {
    it("counts the events given up, from when the first was, and those refused apart", async () => {
      await emptied();
      const row = (state: string, settledAt: string | null) =>
        pool.query(
          `insert into commerce_analytics_events
             (id, name, occurred_at, actor_type, source, properties, refs, state, next_attempt_at,
              sent_at, settled_at)
           values (gen_random_uuid(), 'agc_selling_changed', $1, 'system', 'gateway', '{}', '{}', $2,
                   case when $2 = 'pending' then now() end, case when $2 = 'sent' then $3::timestamptz end,
                   $3)`,
          ["2026-10-15T00:00:00.000Z", state, settledAt],
        );
      await row("pending", null);
      await row("given_up", "2026-10-16T09:00:00.000Z");
      await row("given_up", "2026-10-18T09:00:00.000Z");
      await row("dead", "2026-10-17T09:00:00.000Z");
      await row("sent", "2026-10-17T09:00:00.000Z");

      expect(await postgresOperatorReader(db, NETWORK).figures.analyticsOutbox(LIVE)).toStrictEqual(
        {
          readAt: NOW,
          waiting: 1,
          givenUp: 2,
          givenUpSince: Date.parse("2026-10-16T09:00:00.000Z"),
          refused: 1,
        },
      );
    });
  });
}
