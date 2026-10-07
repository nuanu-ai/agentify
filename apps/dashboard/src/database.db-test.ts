/**
 * The dashboard's database, renamed from the dashboard's old name on a database
 * that already holds people.
 *
 * Every table, index, key and constraint the dashboard made was named for the
 * cabinet, and so was the history its migrations keep. The history is the part
 * that cannot be renamed by a migration: the migrator reads it before it runs
 * anything and applies every file newer than the newest entry it finds, so a
 * history it could not find would send it back to the first file, against
 * tables that are already there. These tests hold the rename on a database
 * migrated under the old names, which is what both channels are.
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

/** The migration that renames everything, and so the last one the old names knew nothing of. */
const THE_RENAME = "0013_dashboard_names";

/**
 * The dashboard's migrations as they stood before the rename, applied the way
 * they were applied then: into the history under its old name.
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

  /** Every object in the database whose name still says cabinet. */
  const namedForTheCabinet = async (): Promise<string[]> => {
    const { rows } = await pool.query<{ name: string }>(
      `select n.nspname || '.' || c.relname as name
         from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where c.relname ilike '%cabinet%'
       union all
       select conname::text from pg_constraint where conname ilike '%cabinet%'
       order by 1`,
    );
    return rows.map((row) => row.name);
  };

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

      expect(await namedForTheCabinet()).toStrictEqual([]);
      expect(await historyLength("dashboard_migrations")).toBe(await journalLength());
      const accounts = await pool.query("select email from dashboard_accounts");
      expect(accounts.rows).toStrictEqual([{ email: "kept@example.com" }]);
      const sends = await pool.query("select purpose from dashboard_link_sends");
      expect(sends.rows).toStrictEqual([{ purpose: "dashboard" }]);

      // The next release finds its history where this one left it, and has
      // nothing to do.
      await migrateAccounts(pool, dashboardMigrations);
      expect(await historyLength("dashboard_migrations")).toBe(await journalLength());
    });

    it("names nothing for the cabinet on a database migrated from empty", async () => {
      await migrateAccounts(pool, dashboardMigrations);

      expect(await namedForTheCabinet()).toStrictEqual([]);
      expect(await historyLength("dashboard_migrations")).toBe(await journalLength());
    });

    it("refuses to choose between two histories rather than run on either", async () => {
      // Two histories means something ran the new migrator against a database
      // the old one had migrated, and which of the two is true cannot be read
      // off either. Nothing is renamed and nothing is applied.
      await migrateAsBeforeTheRename(pool);
      await pool.query("create table drizzle.dashboard_migrations (id serial primary key)");

      await expect(migrateAccounts(pool, dashboardMigrations)).rejects.toThrow(
        /cabinet_migrations.*dashboard_migrations/,
      );
      expect(await historyLength("cabinet_migrations")).toBeGreaterThan(0);
    });
  });
}
