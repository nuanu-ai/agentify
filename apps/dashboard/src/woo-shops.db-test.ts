/**
 * The shared contract run against Postgres, because its two properties are ones
 * a memory store can have by accident and a database has to be written for: a
 * token spent by one caller only (a delete that returns a row) and a sale
 * claimed once however many attempts arrive together (an insert that does
 * nothing on conflict).
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { noDatabaseHere, readyDatabase, testDatabaseUrl } from "@agentify/gateway/testing/database";
import { Pool } from "pg";
import { afterAll, describe, it } from "vitest";
import { migrateAccounts } from "./database.js";
import { wooShopsContract } from "./testing/woo-shops-contract.js";
import { postgresWooShops } from "./woo-shops.js";

/**
 * These tables hang off the accounts table by foreign key, so the suite makes
 * its own accounts, which must not happen in tables another suite empties.
 */
const wanted = (() => {
  const url = new URL(testDatabaseUrl());
  url.pathname = "/agentify_test_dashboard_woo";
  return url.toString();
})();
const databaseUrl = await readyDatabase(wanted);

const here = dirname(fileURLToPath(import.meta.url));
const migrationsIn = join(here, "..", "drizzle");

if (databaseUrl === null) {
  console.log(noDatabaseHere(wanted));

  describe("the WooCommerce connection store on a real database", () => {
    it.skip("is skipped: there is no Postgres to run it against", () => {
      // Intentionally empty: the message above is the whole point.
    });
  });
} else {
  const pool = new Pool({ connectionString: databaseUrl });

  // Drops whatever tables exist rather than a list of names, since a list falls
  // behind the next migration. The migrator's journal schema goes too: it is
  // not in `public`, and left behind it would say everything is applied while
  // the tables are gone.
  await pool.query(`
    do $$
    declare
      present text;
    begin
      select string_agg(format('%I.%I', schemaname, tablename), ', ')
        into present
        from pg_tables
       where schemaname = 'public';
      if present is not null then
        execute 'drop table ' || present || ' cascade';
      end if;
    end $$;
  `);
  await pool.query("drop schema if exists drizzle cascade");
  await migrateAccounts(pool, migrationsIn);

  afterAll(async () => {
    await pool.end();
  });

  /**
   * The contract's concurrent cases only measure a race if the ten calls really
   * overlap; on a cold pool the first call finishes while the second waits for
   * a socket, so a read-then-write would pass the case it exists to fail.
   */
  await Promise.all(Array.from({ length: 10 }, () => pool.query("select 1")));

  let issued = 0;
  const anAccount = async (): Promise<string> => {
    issued += 1;
    const id = `acc_woo_${issued}`;
    await pool.query(
      "insert into dashboard_accounts (id, email, email_verified, name, created_at, updated_at)" +
        " values ($1, $2, false, '', now(), now())",
      [id, `${id}@example.com`],
    );
    return id;
  };

  wooShopsContract("on postgres", async () => {
    // Every row gone, so one case cannot read another's; the accounts too,
    // since they are made per case.
    await pool.query("delete from dashboard_woo_orders");
    await pool.query("delete from dashboard_woo_quotes");
    await pool.query("delete from dashboard_woo_shops");
    await pool.query("delete from dashboard_woo_grants");
    await pool.query("delete from dashboard_accounts");
    return {
      shops: postgresWooShops(pool),
      accounts: { one: await anAccount(), other: await anAccount() },
      close: async () => {},
    };
  });
}
