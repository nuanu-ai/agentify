/**
 * The identity's search of accounts by their address on PostgreSQL, for
 * what only the database can show: its match of text in an address reads `%`
 * and `_` as wildcards, and the read holds what it found to the text exactly.
 * If this fails, a search by the address a merchant pasted lists strangers'
 * merchants beside theirs.
 */

import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { noDatabaseHere, readyDatabase, testDatabaseUrl } from "@agentify/gateway/testing/database";
import { Pool } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { loadConfig } from "../config.js";
import { identityFor } from "../identity.js";
import { TEST_AUTH_SECRET } from "../testing/secrets.js";

const wanted = (() => {
  const url = new URL(testDatabaseUrl());
  url.pathname = "/agentify_test_merchants_accounts";
  return url.toString();
})();
const databaseUrl = await readyDatabase(wanted);
const migrationsIn = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "drizzle");

if (databaseUrl === null) {
  console.log(noDatabaseHere(wanted));
  describe("the accounts found by their address on PostgreSQL", () => {
    it.skip("is skipped: there is no PostgreSQL to run it against", () => {});
  });
} else {
  const pool = new Pool({ connectionString: databaseUrl, max: 4 });
  await pool.query("drop schema public cascade");
  await pool.query("create schema public");
  for (const file of (await readdir(migrationsIn)).filter((name) => name.endsWith(".sql")).sort()) {
    const source = await readFile(join(migrationsIn, file), "utf8");
    for (const statement of source.split("--> statement-breakpoint")) {
      if (statement.trim() !== "") await pool.query(statement);
    }
  }
  const identity = identityFor(
    loadConfig({
      DATABASE_URL: databaseUrl,
      AUTH_SECRET: TEST_AUTH_SECRET,
      PAYMENT_NETWORK: "eip155:84532",
      FACILITATOR_URL: "sandbox:scripted",
    }),
    { pool, postman: async () => "accepted" },
  );

  afterAll(async () => {
    await identity.close();
  });

  describe("the accounts found by their address on PostgreSQL", () => {
    it("finds by the text exactly, a wildcard in it matching only itself", async () => {
      await identity.make("owner_1@coffee.example", "mch_coffee");
      await identity.make("owner21@tours.example", "mch_tours");
      await identity.make("Owner%x@prints.example", "mch_prints");
      const found = async (text: string) =>
        (await identity.accountsWithEmailContaining(text)).accounts
          .map((one) => one.merchantId)
          .sort();

      expect(await found("owner_1")).toStrictEqual(["mch_coffee"]);
      expect(await found("%X@")).toStrictEqual(["mch_prints"]);
      expect(await found("owner")).toStrictEqual(["mch_coffee", "mch_prints", "mch_tours"]);
    });
  });
}
