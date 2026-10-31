/**
 * A step run before the dashboard starts (the `migrate` service locally), not
 * on boot: a process that migrates on boot migrates once per replica, and
 * replicas race over the same tables.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { backfillLiveSalesRequests, liveBackfillMode } from "@agentify/gateway/live-sales";
import { drizzle } from "drizzle-orm/node-postgres";
import { connect, migrateAccounts } from "./database.js";
import { postgresLiveSalesNotices } from "./live-sales-mail.js";

const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl === undefined || databaseUrl === "") {
  console.error("DATABASE_URL is not set, so there is no database to migrate.");
  process.exit(1);
}

const here = dirname(fileURLToPath(import.meta.url));
const pool = connect(databaseUrl);

try {
  await migrateAccounts(pool, join(here, "..", "drizzle"));
  const mode = liveBackfillMode(process.env.PAYMENT_NETWORK, process.env.FACILITATOR_URL);
  const backfill = await backfillLiveSalesRequests(
    drizzle(pool),
    mode,
    postgresLiveSalesNotices({ surfaceMode: mode ?? "sandbox" }),
    new Date(),
  );
  console.log(
    `Live-sales legacy requests: ${backfill.kind}; ${backfill.count} created${mode === null ? " (channel configuration missing or unknown)" : ""}.`,
  );
  console.log("The dashboard's accounts, sessions and emailed links are up to date.");
} finally {
  await pool.end();
}
