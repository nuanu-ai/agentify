/**
 * A dashboard action's change and its journal row on the real database, the
 * dashboard's tables beside the gateway's as a deployment has them: both
 * commit, or neither does, whether the change fails, the row is one the
 * journal refuses, or the transaction fails after the row.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { connect, PostgresStore, randomIds } from "@agentify/gateway";
import type { JournalPress } from "@agentify/gateway/journal";
import { noDatabaseHere, readyDatabase, testDatabaseUrl } from "@agentify/gateway/testing/database";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { migrateAccounts } from "../database.js";
import { type JournalTransaction, postgresJournal, type Settled } from "./journal.js";

const WANTED = (() => {
  const url = new URL(testDatabaseUrl());
  url.pathname = "/agentify_test_dashboard_journal";
  return url.toString();
})();
const databaseUrl = await readyDatabase(WANTED);
const here = dirname(fileURLToPath(import.meta.url));
const gatewayMigrations = join(here, "..", "..", "..", "gateway", "drizzle");
const dashboardMigrations = join(here, "..", "..", "drizzle");

const ENDED: JournalPress = {
  at: Date.parse("2026-10-23T12:00:00Z"),
  actor: { kind: "account", id: "acc_operator" },
  action: "end_sessions",
  subject: { kind: "account", id: "acc_someone" },
  reason: "A laptop was stolen",
};

if (databaseUrl === null) {
  console.log(noDatabaseHere(WANTED));
  describe("a dashboard action and its journal row on a real database", () => {
    it.skip("is skipped: its dedicated PostgreSQL server is unavailable", () => undefined);
  });
} else {
  const { db, pool } = connect(databaseUrl);
  const store = PostgresStore.over(db, "eip155:84532", randomIds);
  const journal = postgresJournal(pool);

  await pool.query("drop schema public cascade");
  await pool.query("drop schema if exists drizzle cascade");
  await pool.query("create schema public");
  await migrate(drizzle(pool), { migrationsFolder: gatewayMigrations });
  await migrateAccounts(pool, dashboardMigrations);

  /** A change of the dashboard's own: a row in one of its tables. */
  const linkSends = async () =>
    Number((await pool.query("select count(*) as n from dashboard_link_sends")).rows[0]?.n);
  const aChange = async (tx: JournalTransaction | null) => {
    if (tx === null) throw new Error("a change on Postgres is handed its transaction");
    await tx.execute(
      sql`insert into dashboard_link_sends (id, email_hash, purpose, sent_at, expires_at) values (gen_random_uuid()::text, 'hash', 'dashboard', now(), now() + interval '1 day')`,
    );
  };
  const changing =
    (changed: boolean | null) =>
    async (tx: JournalTransaction | null): Promise<Settled<number>> => {
      await aChange(tx);
      return { result: 1, changed };
    };

  beforeEach(async () => {
    await pool.query("truncate table operator_journal, dashboard_link_sends");
  });

  afterAll(async () => {
    await pool.end();
  });

  describe("a dashboard action and its journal row on a real database", () => {
    it("commits the change with its row, done or unchanged as the change settles it", async () => {
      await journal.along(ENDED, changing(true));
      await journal.along(ENDED, changing(false));

      expect(await linkSends()).toBe(2);
      expect(
        (await store.journal({ about: { account: "acc_someone" }, limit: 5 })).rows,
      ).toMatchObject([
        { action: "end_sessions", outcome: { kind: "unchanged" } },
        { action: "end_sessions", outcome: { kind: "done" }, reason: "A laptop was stolen" },
      ]);
    });

    it("refuses a change whose row the journal refuses, before it runs", async () => {
      await expect(journal.along({ ...ENDED, reason: "" }, changing(true))).rejects.toThrow();

      expect(await linkSends()).toBe(0);
      expect((await store.journal({ limit: 5 })).total).toBe(0);
    });

    it("rolls back a change that failed half way, and writes no row", async () => {
      await expect(
        journal.along(ENDED, async (tx) => {
          await aChange(tx);
          throw new Error("the change failed half way");
        }),
      ).rejects.toThrow("the change failed half way");

      expect(await linkSends()).toBe(0);
      expect((await store.journal({ limit: 5 })).total).toBe(0);
    });

    it("writes the change alone where it found nothing to act on", async () => {
      await journal.along(ENDED, changing(null));

      expect(await linkSends()).toBe(1);
      expect((await store.journal({ limit: 5 })).total).toBe(0);
    });
  });
}
