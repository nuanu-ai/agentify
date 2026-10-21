/**
 * A database migrated from empty takes the dashboard's names for every object
 * except the migration history, which every revision has to find under one
 * name (see `database.ts`).
 */

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { noDatabaseHere, readyDatabase, testDatabaseUrl } from "@agentify/gateway/testing/database";
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
    it("names nothing but the history for the cabinet on a database migrated from empty", async () => {
      await migrateAccounts(pool, dashboardMigrations);

      expect(await namedForTheCabinet()).toStrictEqual(ONLY_THE_HISTORY);
      expect(await historyLength("cabinet_migrations")).toBe(await journalLength());
    });
  });
}
