/**
 * The identity's reads for the operator's workspace on PostgreSQL, held to the
 * promises the memory rows keep (`testing/identity-admin-reads.ts`).
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { noDatabaseHere, readyDatabase, testDatabaseUrl } from "@agentify/gateway/testing/database";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { afterAll, describe, it } from "vitest";
import { loadConfig } from "./config.js";
import { migrateAccounts } from "./database.js";
import { identityFor } from "./identity.js";
import { describeAdminReads } from "./testing/identity-admin-reads.js";
import { TEST_AUTH_SECRET } from "./testing/secrets.js";

const wanted = (() => {
  const url = new URL(testDatabaseUrl());
  url.pathname = "/agentify_test_figures_identity";
  return url.toString();
})();
const databaseUrl = await readyDatabase(wanted);
const here = dirname(fileURLToPath(import.meta.url));

if (databaseUrl === null) {
  console.log(noDatabaseHere(wanted));
  describe("the identity's reads for the workspace on PostgreSQL", () => {
    it.skip("is skipped: there is no PostgreSQL to run it against", () => {});
  });
} else {
  const pool = new Pool({ connectionString: databaseUrl, max: 4 });
  await pool.query("drop schema public cascade");
  await pool.query("drop schema if exists drizzle cascade");
  await pool.query("create schema public");
  await migrate(drizzle(pool), {
    migrationsFolder: join(here, "..", "..", "gateway", "drizzle"),
  });
  await migrateAccounts(pool, join(here, "..", "drizzle"));

  const identity = identityFor(
    loadConfig({
      DATABASE_URL: databaseUrl,
      AUTH_SECRET: TEST_AUTH_SECRET,
      PAYMENT_NETWORK: "eip155:84532",
      FACILITATOR_URL: "sandbox:scripted",
    }),
    { pool },
  );

  afterAll(async () => {
    await identity.close();
  });

  describeAdminReads("the identity's reads for the workspace on PostgreSQL", async (held) => {
    await pool.query(
      "truncate dashboard_ad_reports, dashboard_link_sends, dashboard_accounts cascade",
    );
    for (const account of held.accounts) {
      await pool.query(
        `insert into dashboard_accounts (id, email, email_verified, name, created_at, updated_at, merchant_id)
         values ($1, $2, true, '', now(), now(), $3)`,
        [account.id, account.email, account.merchantId],
      );
    }
    for (const send of held.linkSends) {
      await pool.query(
        `insert into dashboard_link_sends (id, email_hash, purpose, sent_at, expires_at)
         values ($1, 'h', $2, $3, $3::timestamptz + interval '7 days')`,
        [send.id, send.purpose, send.sentAt],
      );
    }
    for (const report of held.adReports) {
      const open = report.state === "waiting" || report.state === "pending";
      await pool.query(
        `insert into dashboard_ad_reports
           (account_id, event, click_id, state, next_attempt_at, created_at, event_at, settled_at)
         values ($1, $2, $3, $4, $5, now(), $6, $7)`,
        [
          report.accountId,
          report.event,
          open ? "qa_click_0123456789abcdef" : null,
          report.state,
          report.state === "pending" ? new Date() : null,
          report.state === "waiting" ? null : new Date(),
          report.settledAt,
        ],
      );
    }
    return identity;
  });
}
