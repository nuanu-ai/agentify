import {
  anonymizeLeadData,
  leads,
  runRetentionCleanup,
  scannerAuthUsers,
  scannerAuthVerifications,
  type DatabaseTransaction,
} from "@agentify/scanner-database";
import { and, eq, lt, ne, sql } from "drizzle-orm";

import { decryptEmail, hmacHex, normalizeEmail } from "./crypto";
import { getDatabase } from "./database";
import { getServerConfig } from "./config";
import { detachLeadCardSignalsForDeletion } from "./stripe-card-signal";
import type { StripeCardSignalProvider } from "./stripe-card-signal-provider";

async function deleteLinkedScannerUser(
  tx: DatabaseTransaction,
  leadId: string,
) {
  const linked = (
    await tx
      .select({
        scannerAuthUserId: leads.scannerAuthUserId,
        emailLookupHash: leads.emailLookupHash,
        emailNormalizedCiphertext: leads.emailNormalizedCiphertext,
      })
      .from(leads)
      .where(eq(leads.id, leadId))
      .limit(1)
  )[0];
  if (!linked) return { status: "not_linked" as const };
  let email: string | undefined;
  if (linked.emailNormalizedCiphertext !== "deleted") {
    const config = getServerConfig();
    email = normalizeEmail(
      decryptEmail(linked.emailNormalizedCiphertext, config.encryptionKey),
    );
    if (hmacHex(config.hmacSecret, "email", email) !== linked.emailLookupHash) {
      throw new Error("lead_email_identity_mismatch");
    }
    // BA verification values contain the address but have no account FK: a
    // pending link for a legacy-only lead must be erased with that lead too.
    await tx
      .delete(scannerAuthVerifications)
      .where(
        sql`${scannerAuthVerifications.value}::jsonb ->> 'email' = ${email}`,
      );
  }
  // Include an identity left unlinked by an older split-transaction failure.
  const byEmail = email
    ? (
        await tx
          .select({ id: scannerAuthUsers.id })
          .from(scannerAuthUsers)
          .where(sql`lower(${scannerAuthUsers.email}) = ${email}`)
          .limit(1)
      )[0]
    : undefined;
  const linkedUser = linked.scannerAuthUserId
    ? (
        await tx
          .select({ email: scannerAuthUsers.email })
          .from(scannerAuthUsers)
          .where(eq(scannerAuthUsers.id, linked.scannerAuthUserId))
          .limit(1)
      )[0]
    : undefined;
  if (
    linked.scannerAuthUserId &&
    (!email || !linkedUser || normalizeEmail(linkedUser.email) !== email)
  )
    throw new Error("lead_email_identity_mismatch");
  if (
    linked.scannerAuthUserId &&
    byEmail &&
    linked.scannerAuthUserId !== byEmail.id
  )
    throw new Error("lead_email_identity_mismatch");
  const userId = linked.scannerAuthUserId ?? byEmail?.id;
  // A report belonging to another lead cannot lose its identity here.
  if (!userId) return { status: "not_linked" as const };
  const anotherLead = (
    await tx
      .select({ id: leads.id })
      .from(leads)
      .where(and(eq(leads.scannerAuthUserId, userId), ne(leads.id, leadId)))
      .limit(1)
  )[0];
  if (anotherLead) throw new Error("scanner_identity_shared_by_leads");
  await tx.delete(scannerAuthUsers).where(eq(scannerAuthUsers.id, userId));
  return { status: "deleted" as const };
}

export async function completeLeadDeletion(input: {
  leadId: string;
  provider?: StripeCardSignalProvider;
  now?: Date;
}) {
  const providerResult = await detachLeadCardSignalsForDeletion(
    input.leadId,
    input.provider,
  );
  let identityResult: { status: "deleted" | "not_linked" } = {
    status: "not_linked",
  };
  const databaseResult = await anonymizeLeadData(
    getDatabase().db,
    input.leadId,
    input.now,
    async (tx, leadId) => {
      identityResult = await deleteLinkedScannerUser(tx, leadId);
    },
  );
  if (databaseResult.status === "not_found")
    throw new Error("lead_deletion_target_missing");
  return {
    provider: providerResult,
    identity: identityResult,
    database: databaseResult,
  } as const;
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
      await deleteLinkedScannerUser(tx, leadId);
    },
  });
  const staleVerificationCutoff = new Date(now.getTime() - 7 * 86_400_000);
  const expiredLinks = await getDatabase()
    .db.delete(scannerAuthVerifications)
    .where(lt(scannerAuthVerifications.expiresAt, staleVerificationCutoff))
    .returning({ id: scannerAuthVerifications.id });
  return { ...database, expiredScannerAuthLinks: expiredLinks.length };
}
