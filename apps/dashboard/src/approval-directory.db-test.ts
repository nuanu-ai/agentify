/**
 * The production approval seam over the real dashboard and gateway tables.
 *
 * This file owns a database no other suite uses. It proves the targeted
 * dashboard lookup and the gateway's atomic one-way grant compose through one
 * pool, including preservation of the first timestamp on a repeated command.
 */

import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { connect, grantLiveApproval, PostgresStore, randomIds } from "@agentify/gateway";
import { noDatabaseHere, readyDatabase, testDatabaseUrl } from "@agentify/gateway/testing/database";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { runApproval } from "./approval-command.js";
import { PostgresApprovalDirectory } from "./approval-directory.js";
import { migrateAccounts } from "./database.js";

const WANTED = (() => {
  const url = new URL(testDatabaseUrl());
  url.pathname = "/agentify_approval_operator_test";
  return url.toString();
})();
const databaseUrl = await readyDatabase(WANTED);
const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..", "..");
const tsx = join(root, "apps", "dashboard", "node_modules", "tsx", "dist", "loader.mjs");
const gatewayMigrations = join(here, "..", "..", "gateway", "drizzle");
const dashboardMigrations = join(here, "..", "drizzle");

const MERCHANT = "mch_approval_operator";
const EMAIL = "merchant@example.com";
const FIRST_GRANT = Date.parse("2026-09-17T10:00:00.000Z");

if (databaseUrl === null) {
  console.log(noDatabaseHere(WANTED));
  describe("the approval operator on its real database", () => {
    it.skip("is skipped: its dedicated PostgreSQL server is unavailable", () => undefined);
  });
} else {
  const connected = connect(databaseUrl);
  const store = PostgresStore.over(connected.db, randomIds);
  const directory = new PostgresApprovalDirectory(connected.pool);

  afterAll(async () => {
    await connected.pool.end();
  });

  beforeEach(async () => {
    await connected.pool.query("drop schema public cascade");
    await connected.pool.query("drop schema if exists drizzle cascade");
    await connected.pool.query("create schema public");
    await migrate(drizzle(connected.pool), { migrationsFolder: gatewayMigrations });
    await migrateAccounts(connected.pool, dashboardMigrations);
  });

  const account = async (id: string, email: string, merchantId: string | null): Promise<void> => {
    await connected.pool.query(
      `insert into dashboard_accounts
         (id, email, email_verified, name, created_at, updated_at, merchant_id)
       values ($1, $2, false, '', now(), now(), $3)`,
      [id, email, merchantId],
    );
  };

  const run = async (
    rawEmail: string,
    at: number,
  ): Promise<{ readonly code: number; readonly output: string }> => {
    const lines: string[] = [];
    const code = await runApproval(
      rawEmail,
      directory,
      {
        grant: async (merchantId) => await grantLiveApproval(store, merchantId, at),
      },
      { say: (line) => lines.push(line) },
    );
    return { code, output: lines.join("\n") };
  };

  describe("the approval operator on its real database", () => {
    it("runs the private production entry point with the email arriving on stdin", async () => {
      await store.addMerchant(
        { id: MERCHANT, name: "The account holder's merchant" },
        FIRST_GRANT - 2_000,
      );
      await store.setServiceName(MERCHANT, "The public seller", FIRST_GRANT - 1_000);
      await account("acc_merchant", EMAIL, MERCHANT);

      const result = spawnSync(
        process.execPath,
        ["--import", tsx, join(root, "apps", "dashboard", "src", "approve.ts")],
        {
          cwd: root,
          encoding: "utf8",
          env: {
            ...process.env,
            DATABASE_URL: databaseUrl,
            PAYMENT_NETWORK: "eip155:8453",
          },
          input: `  Merchant@Example.COM\n`,
        },
      );
      const output = `${result.stdout}\n${result.stderr}`;

      expect(result.status, output).toBe(0);
      expect(output).toMatch(/production/i);
      expect(output).toMatch(/approved now/i);
      expect(output).toContain(EMAIL);
      expect(output).toContain(MERCHANT);
      expect(output).not.toContain(databaseUrl);
      expect((await store.merchantById(MERCHANT))?.liveApprovedAt).not.toBeNull();
    });

    it("resolves one normalized dashboard binding and preserves the first gateway timestamp", async () => {
      const made = await store.addMerchant(
        { id: MERCHANT, name: "The account holder's merchant" },
        FIRST_GRANT - 2_000,
      );
      expect(made?.liveApprovedAt).toBeNull();
      await store.setServiceName(MERCHANT, "The public seller", FIRST_GRANT - 1_000);
      await account("acc_merchant", EMAIL, MERCHANT);

      const first = await run("  Merchant@Example.COM\n", FIRST_GRANT);
      const repeated = await run(EMAIL, FIRST_GRANT + 60_000);
      const stored = await store.merchantById(MERCHANT);

      expect(first.code).toBe(0);
      expect(first.output).toMatch(/approved now/i);
      expect(first.output).toContain(EMAIL);
      expect(first.output).toContain("The public seller");
      expect(first.output).toContain(MERCHANT);
      expect(repeated.code).toBe(0);
      expect(repeated.output).toMatch(/already approved/i);
      expect(stored?.liveApprovedAt).toBe(FIRST_GRANT);
    });

    it("returns at most two normalized matches so ambiguous history cannot select a merchant", async () => {
      await account("acc_one", EMAIL, "mch_one");
      await account("acc_two", " MERCHANT@example.com ", "mch_two");
      await account("acc_three", "MERCHANT@EXAMPLE.COM", "mch_three");

      const matches = await directory.resolve(" merchant@example.com ");
      let grants = 0;
      const lines: string[] = [];
      const code = await runApproval(
        EMAIL,
        directory,
        {
          grant: async () => {
            grants += 1;
            return null;
          },
        },
        { say: (line) => lines.push(line) },
      );

      expect(matches).toHaveLength(2);
      expect(code).not.toBe(0);
      expect(lines.join("\n")).toMatch(/more than one/i);
      expect(grants).toBe(0);
    });

    it("reports an account with no merchant as unbound", async () => {
      await account("acc_unbound", "unbound@example.com", null);

      await expect(directory.resolve("UNBOUND@example.com")).resolves.toStrictEqual([
        { email: "unbound@example.com", binding: "unbound" },
      ]);
    });
  });
}
