/**
 * The rename migration, on a database that already holds people under the
 * `cabinet` names. Every object takes the dashboard's name except the migration
 * history, which every revision has to find under one name (see `database.ts`).
 */

import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { noDatabaseHere, readyDatabase, testDatabaseUrl } from "@agentify/gateway/testing/database";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { connect, migrateAccounts } from "./database.js";

const WANTED = (() => {
  const url = new URL(testDatabaseUrl());
  url.pathname = "/agentify_test_dashboard_history";
  return url.toString();
})();
const databaseUrl = await readyDatabase(WANTED);
const here = dirname(fileURLToPath(import.meta.url));
const dashboardMigrations = join(here, "..", "drizzle");

const THE_RENAME = "0013_dashboard_names";

/**
 * Applies the migrations before the rename into the history's table, as a
 * database migrated under the old names has them.
 */
async function migrateAsBeforeTheRename(pool: ReturnType<typeof connect>): Promise<void> {
  const folder = await mkdtemp(join(tmpdir(), "dashboard-migrations-"));
  try {
    await cp(dashboardMigrations, folder, { recursive: true });
    const journalFile = join(folder, "meta", "_journal.json");
    const journal = JSON.parse(await readFile(journalFile, "utf8")) as {
      entries: { tag: string }[];
    };
    const cut = journal.entries.findIndex((entry) => entry.tag === THE_RENAME);
    if (cut === -1) throw new Error(`the journal has no ${THE_RENAME}`);
    journal.entries = journal.entries.slice(0, cut);
    await writeFile(journalFile, JSON.stringify(journal));
    await migrate(drizzle(pool), {
      migrationsFolder: folder,
      migrationsTable: "cabinet_migrations",
    });
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}

if (databaseUrl === null) {
  console.log(noDatabaseHere(WANTED));
  describe("the dashboard's database under its own name", () => {
    it.skip("is skipped: its dedicated PostgreSQL server is unavailable", () => undefined);
  });
} else {
  const pool = connect(databaseUrl);

  /**
   * Object kinds: `r` table, `v` view, `i` index, `S` sequence, `c` constraint.
   */
  const namedForTheCabinet = async (): Promise<string[]> => {
    const { rows } = await pool.query<{ name: string }>(
      `select c.relkind::text || ' ' || n.nspname || '.' || c.relname as name
         from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where c.relname ilike '%cabinet%'
       union all
       select 'c ' || conname::text from pg_constraint where conname ilike '%cabinet%'`,
    );
    return rows.map((row) => row.name).sort();
  };

  const ONLY_THE_HISTORY = [
    "S drizzle.cabinet_migrations_id_seq",
    "c cabinet_migrations_pkey",
    "i drizzle.cabinet_migrations_pkey",
    "r drizzle.cabinet_migrations",
  ];

  const historyLength = async (table: string): Promise<number> => {
    const { rows } = await pool.query<{ count: string }>(
      `select count(*) as count from drizzle.${table}`,
    );
    return Number(rows[0]?.count);
  };

  const journalLength = async (): Promise<number> => {
    const journal = JSON.parse(
      await readFile(join(dashboardMigrations, "meta", "_journal.json"), "utf8"),
    ) as { entries: unknown[] };
    return journal.entries.length;
  };

  beforeEach(async () => {
    await pool.query("drop schema if exists drizzle cascade");
    await pool.query("drop schema public cascade");
    await pool.query("create schema public");
  });

  afterAll(async () => {
    await pool.end();
  });

  describe("the dashboard's database under its own name", () => {
    it("carries a database migrated under the old names forward, every migration once and every row kept", async () => {
      await migrateAsBeforeTheRename(pool);
      await pool.query(
        `insert into cabinet_accounts (id, email, email_verified, created_at, updated_at)
         values ('acc_kept', 'kept@example.com', true, now(), now())`,
      );
      await pool.query(
        `insert into cabinet_link_sends (id, email_hash, purpose, sent_at, expires_at)
         values ('send_kept', 'a-hash', 'cabinet', now(), now() + interval '1 hour')`,
      );

      await migrateAccounts(pool, dashboardMigrations);

      expect(await namedForTheCabinet()).toStrictEqual(ONLY_THE_HISTORY);
      expect(await historyLength("cabinet_migrations")).toBe(await journalLength());
      const accounts = await pool.query("select email from dashboard_accounts");
      expect(accounts.rows).toStrictEqual([{ email: "kept@example.com" }]);
      // Emptied rather than carried: its rows are keyed by a hash made with the
      // old name, so kept they would count toward no limit and `pnpm forget`
      // would not find them.
      const sends = await pool.query("select id from dashboard_link_sends");
      expect(sends.rows).toStrictEqual([]);

      await migrateAccounts(pool, dashboardMigrations);
      expect(await historyLength("cabinet_migrations")).toBe(await journalLength());
    });

    it("names nothing but the history for the cabinet on a database migrated from empty", async () => {
      await migrateAccounts(pool, dashboardMigrations);

      expect(await namedForTheCabinet()).toStrictEqual(ONLY_THE_HISTORY);
      expect(await historyLength("cabinet_migrations")).toBe(await journalLength());
    });

    it("leaves an older revision's migrator nothing to apply, so it builds no empty tables beside the real ones", async () => {
      // An older revision finds the history where it always was, applies
      // nothing, and then fails on missing tables instead of serving empty ones
      // beside the real ones.
      await migrateAsBeforeTheRename(pool);
      await pool.query(
        `insert into cabinet_accounts (id, email, email_verified, created_at, updated_at)
         values ('acc_kept', 'kept@example.com', true, now(), now())`,
      );
      await migrateAccounts(pool, dashboardMigrations);

      await migrateAsBeforeTheRename(pool);

      expect(await namedForTheCabinet()).toStrictEqual(ONLY_THE_HISTORY);
      expect(await historyLength("cabinet_migrations")).toBe(await journalLength());
      const accounts = await pool.query("select email from dashboard_accounts");
      expect(accounts.rows).toStrictEqual([{ email: "kept@example.com" }]);

      await migrateAccounts(pool, dashboardMigrations);
      expect(await namedForTheCabinet()).toStrictEqual(ONLY_THE_HISTORY);
      expect(await historyLength("cabinet_migrations")).toBe(await journalLength());
    });
  });
}
