import {
  listUnverifiedLeadRetentionCandidates,
  merchantApplications,
  rateLimitEvents,
  rateWindows,
  registrationIntents,
  scannerIdentityCompletions,
  scannerRecoveryIntents,
} from "@agentify/scanner-database";
import { sql } from "drizzle-orm";

import { getDatabase } from "../lib/server/database";
import { executeRetentionCleanup } from "../lib/server/privacy";

if (process.env.PRIVACY_CLEANUP_ACK !== "yes") {
  throw new Error("Refusing privacy cleanup without PRIVACY_CLEANUP_ACK=yes");
}
const batchSize = Math.min(
  1_000,
  Math.max(1, Number(process.env.PRIVACY_CLEANUP_BATCH_SIZE ?? 100)),
);
async function main() {
  const { db, pool } = getDatabase();
  try {
    if (process.env.PRIVACY_CLEANUP_DRY_RUN === "true") {
      const now = new Date();
      const overdueMerchants = await db.execute<{ count: number }>(
        sql`select count(*)::int as count from ${merchantApplications} where ${merchantApplications.expiresAt} < ${now}`,
      );
      const candidates = await listUnverifiedLeadRetentionCandidates(db, {
        limit: batchSize,
      });
      const expiredRateLimits = await db.execute<{ count: number }>(sql`
        select (
          (select count(*) from ${rateLimitEvents} where ${rateLimitEvents.expiresAt} <= now()) +
          (select count(*) from ${rateWindows} where ${rateWindows.expiresAt} <= now())
        )::int as count
      `);
      const overdueRegistrationIntents = await db.execute<{ count: number }>(
        sql`select count(*)::int as count from ${registrationIntents}
          where coalesce(${registrationIntents.consumedAt}, ${registrationIntents.expiresAt}) < now() - interval '7 days'`,
      );
      const expiredScannerRecoveryIntents = await db.execute<{ count: number }>(
        sql`select count(*)::int as count from ${scannerRecoveryIntents}
          where coalesce(${scannerRecoveryIntents.consumedAt}, ${scannerRecoveryIntents.expiresAt}) <= now() - interval '7 days'`,
      );
      const expiredScannerIdentityCompletions = await db.execute<{
        count: number;
      }>(
        sql`select count(*)::int as count from ${scannerIdentityCompletions}
          where ${scannerIdentityCompletions.retainUntil} <= now()`,
      );
      process.stdout.write(
        `${JSON.stringify({
          dryRun: true,
          overdueMerchantApplications: overdueMerchants.rows[0]?.count ?? 0,
          overdueRegistrationIntents: overdueRegistrationIntents.rows[0]?.count ?? 0,
          expiredScannerRecoveryIntents: expiredScannerRecoveryIntents.rows[0]?.count ?? 0,
          expiredScannerIdentityCompletions: expiredScannerIdentityCompletions.rows[0]?.count ?? 0,
          expiredRateLimitRows: expiredRateLimits.rows[0]?.count ?? 0,
          unverifiedLeadCandidates: candidates.length,
        })}\n`,
      );
    } else {
      const result = await executeRetentionCleanup({ batchSize });
      process.stdout.write(`${JSON.stringify({ dryRun: false, ...result })}\n`);
    }
  } finally {
    await pool.end();
  }
}

void main().catch((error: unknown) => {
  process.stderr.write(
    `Privacy cleanup failed: ${error instanceof Error ? error.message : "unknown_error"}\n`,
  );
  process.exitCode = 1;
});
