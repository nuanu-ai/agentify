import {
  type DatabaseTransaction,
  runRetentionCleanup,
  scannerIdentityCompletions,
  scannerRecoveryIntents,
} from "@agentify/scanner-database";
import { eq, lte, sql } from "drizzle-orm";

import { getDatabase } from "./database";
import { detachLeadCardSignalsForDeletion } from "./stripe-card-signal";
import type { StripeCardSignalProvider } from "./stripe-card-signal-provider";

async function deleteScannerReportIdentityRows(tx: DatabaseTransaction, leadId: string) {
  await tx.delete(scannerRecoveryIntents).where(eq(scannerRecoveryIntents.leadId, leadId));
  await tx.delete(scannerIdentityCompletions).where(eq(scannerIdentityCompletions.leadId, leadId));
}

export async function executeRetentionCleanup(input: {
  now?: Date;
  batchSize?: number;
  provider?: StripeCardSignalProvider;
}) {
  const now = input.now ?? new Date();
  const database = await runRetentionCleanup(getDatabase().db, {
    now,
    batchSize: input.batchSize,
    beforeLeadAnonymize: async (leadId) => {
      await detachLeadCardSignalsForDeletion(leadId, input.provider);
    },
    beforeLeadAnonymizeInTransaction: async (tx, leadId) => {
      await deleteScannerReportIdentityRows(tx, leadId);
    },
  });
  const staleEvidenceCutoff = new Date(now.getTime() - 7 * 86_400_000);
  const [expiredRecoveryIntents, expiredCompletions] = await Promise.all([
    getDatabase()
      .db.delete(scannerRecoveryIntents)
      .where(
        sql`coalesce(${scannerRecoveryIntents.consumedAt}, ${scannerRecoveryIntents.expiresAt}) <= ${staleEvidenceCutoff}`,
      )
      .returning({ id: scannerRecoveryIntents.id }),
    getDatabase()
      .db.delete(scannerIdentityCompletions)
      .where(lte(scannerIdentityCompletions.retainUntil, now))
      .returning({ receiptId: scannerIdentityCompletions.receiptId }),
  ]);
  return {
    ...database,
    expiredScannerRecoveryIntents: expiredRecoveryIntents.length,
    expiredScannerIdentityCompletions: expiredCompletions.length,
  };
}
