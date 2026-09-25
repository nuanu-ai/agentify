/**
 * The WooCommerce connection store against a real database, on the tables the
 * checked-in migration builds.
 *
 * The same contract the memory store keeps, run against Postgres, because the
 * two properties this store exists for are exactly the ones a memory
 * implementation can have by accident and a database has to be written for: a
 * token spent by one caller and no other, and a sale claimed once however many
 * attempts arrive at once. The first is a delete that returns a row; the second
 * is an insert that does nothing on conflict. Neither can be checked without a
 * database underneath.
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
 * A database of this file's own.
 *
 * The tables here hang off the accounts table by foreign key, so the suite
 * makes accounts of its own — which is not something to do to tables another
 * suite is emptying between its tests.
 */
const wanted = (() => {
  const url = new URL(testDatabaseUrl());
  url.pathname = "/agentify_test_cabinet_woo";
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

  // Both halves of the reset are lessons this file learned by failing.
  //
  // It takes whatever tables are there rather than a list of their names,
  // because everything in this database is built by the migrations about to
  // run again, and a list is written once and then falls behind the next
  // migration. That is not hypothetical: the list here was missing the report
  // tombstones for two migrations, so every run after the first died on a
  // table it had never been told to drop.
  //
  // And the schema the migrator journals in goes with the tables, which is the
  // half that is easy to miss: it is not in `public`, so dropping the tables
  // alone leaves a journal saying they are all still there, the next migration
  // run concludes there is nothing to apply, and the suite fails on a table
  // that does not exist.
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
   * Opens every connection the pool will hold, before anything is measured.
   *
   * The two cases in the contract that fire ten calls at once are measuring
   * whether one statement settles a race, and they can only measure it if the
   * ten calls really do overlap. A pool starts empty and opens connections as
   * they are asked for, so without this the first call finishes its whole round
   * trip while the second is still waiting for a socket — the calls serialise,
   * a read followed by a write passes, and the case reports green over the
   * defect it exists for. Measured: with a select-then-delete standing in for
   * the single statement, the grant case passes on a cold pool and fails on a
   * warm one.
   */
  await Promise.all(Array.from({ length: 10 }, () => pool.query("select 1")));

  /** Two accounts for the rows to hang off, made fresh for each run. */
  let issued = 0;
  const anAccount = async (): Promise<string> => {
    issued += 1;
    const id = `acc_woo_${issued}`;
    await pool.query(
      "insert into cabinet_accounts (id, email, email_verified, name, created_at, updated_at)" +
        " values ($1, $2, false, '', now(), now())",
      [id, `${id}@example.com`],
    );
    return id;
  };

  wooShopsContract("on postgres", async () => {
    // Everything these tables hold, gone, so that one case cannot read a row
    // another one wrote. The accounts go with them: they are made per case.
    await pool.query("delete from cabinet_woo_orders");
    await pool.query("delete from cabinet_woo_quotes");
    await pool.query("delete from cabinet_woo_shops");
    await pool.query("delete from cabinet_woo_grants");
    await pool.query("delete from cabinet_accounts");
    return {
      shops: postgresWooShops(pool),
      accounts: { one: await anAccount(), other: await anAccount() },
      close: async () => {},
    };
  });
}
