import { anonymizeLeadData } from "@agentify/scanner-database";
import {
  createUuidV7,
  leads,
  registrationIntents,
  reportSessions,
  scannerIdentityCompletions,
  scannerIdentityDeletionOperations,
  scannerRecoveryIntents,
} from "@agentify/scanner-database";
import { and, asc, eq, isNull, lt, or, sql } from "drizzle-orm";

import { getCabinetReportIdentityClient } from "./cabinet-report-identity";
import { getServerConfig } from "./config";
import { decryptEmail, hmacHex, normalizeEmail } from "./crypto";
import { getDatabase } from "./database";
import { detachLeadCardSignalsForDeletion } from "./stripe-card-signal";
import type { StripeCardSignalProvider } from "./stripe-card-signal-provider";

const CLAIM_LEASE_MS = 2 * 60_000;
const PROVIDER_LEASE_MS = 5 * 60_000;
const RETRY_BATCH_SIZE = 10;

type CabinetResult = "deleted" | "already_absent" | "retained";

export async function beginScannerIdentityDeletion(leadId: string) {
  return await getDatabase().db.transaction(async (tx) => {
    const snapshot = (
      await tx
        .select({
          id: leads.id,
          emailLookupHash: leads.emailLookupHash,
        })
        .from(leads)
        .where(eq(leads.id, leadId))
        .limit(1)
    )[0];
    if (!snapshot) {
      throw new Error("lead_deletion_target_missing");
    }
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${snapshot.emailLookupHash}, 0))`,
    );
    const lead = (
      await tx
        .select({
          id: leads.id,
          emailLookupHash: leads.emailLookupHash,
          encryptedEmail: leads.emailNormalizedCiphertext,
          anonymizedAt: leads.anonymizedAt,
        })
        .from(leads)
        .where(eq(leads.id, leadId))
        .limit(1)
        .for("update")
    )[0];
    if (
      !lead ||
      lead.emailLookupHash !== snapshot.emailLookupHash ||
      lead.anonymizedAt ||
      lead.encryptedEmail === "deleted"
    ) {
      throw new Error("lead_deletion_target_missing");
    }
    const existing = (
      await tx
        .select()
        .from(scannerIdentityDeletionOperations)
        .where(eq(scannerIdentityDeletionOperations.leadId, leadId))
        .limit(1)
    )[0];
    if (existing) return existing;
    const operationId = createUuidV7();
    const now = new Date();
    await tx.insert(scannerIdentityDeletionOperations).values({
      operationId,
      leadId,
      createdAt: now,
    });
    await tx
      .update(leads)
      .set({ deletionRequestedAt: now })
      .where(eq(leads.id, leadId));
    await tx
      .update(reportSessions)
      .set({ revokedAt: now })
      .where(
        and(
          eq(reportSessions.leadId, leadId),
          isNull(reportSessions.revokedAt),
        ),
      );
    await tx
      .delete(scannerRecoveryIntents)
      .where(eq(scannerRecoveryIntents.leadId, leadId));
    await tx
      .delete(registrationIntents)
      .where(eq(registrationIntents.emailLookupHash, lead.emailLookupHash));
    return (
      await tx
        .select()
        .from(scannerIdentityDeletionOperations)
        .where(eq(scannerIdentityDeletionOperations.operationId, operationId))
        .limit(1)
    )[0]!;
  });
}

async function claimDeletionOperation(operationId?: string) {
  return await getDatabase().db.transaction(async (tx) => {
    const now = new Date();
    const row = (
      await tx
        .select()
        .from(scannerIdentityDeletionOperations)
        .where(
          and(
            ...(operationId
              ? [eq(scannerIdentityDeletionOperations.operationId, operationId)]
              : []),
            isNull(scannerIdentityDeletionOperations.completedAt),
            or(
              isNull(scannerIdentityDeletionOperations.leaseExpiresAt),
              lt(scannerIdentityDeletionOperations.leaseExpiresAt, now),
            ),
          ),
        )
        .orderBy(asc(scannerIdentityDeletionOperations.createdAt))
        .limit(1)
        .for("update", { skipLocked: true })
    )[0];
    if (!row) return undefined;
    const leaseToken = createUuidV7();
    const claimed = (
      await tx
        .update(scannerIdentityDeletionOperations)
        .set({
          leaseToken,
          leaseExpiresAt: new Date(now.getTime() + CLAIM_LEASE_MS),
        })
        .where(
          and(
            eq(scannerIdentityDeletionOperations.operationId, row.operationId),
            isNull(scannerIdentityDeletionOperations.completedAt),
          ),
        )
        .returning()
    )[0];
    return claimed ? { ...claimed, leaseToken } : undefined;
  });
}

export async function runScannerIdentityDeletionOperation(
  input: {
    operationId?: string;
    provider?: StripeCardSignalProvider;
  } = {},
): Promise<"completed" | "pending" | "not_found"> {
  const claimed = await claimDeletionOperation(input.operationId);
  if (!claimed || !claimed.leaseToken) return "not_found";
  const lead = (
    await getDatabase()
      .db.select({
        encryptedEmail: leads.emailNormalizedCiphertext,
        emailLookupHash: leads.emailLookupHash,
      })
      .from(leads)
      .where(eq(leads.id, claimed.leadId))
      .limit(1)
  )[0];
  if (!lead || lead.encryptedEmail === "deleted") return "pending";
  const config = getServerConfig();
  const email = normalizeEmail(
    decryptEmail(lead.encryptedEmail, config.encryptionKey),
  );
  if (hmacHex(config.hmacSecret, "email", email) !== lead.emailLookupHash) {
    throw new Error("lead_email_identity_mismatch");
  }

  let cabinetResult = claimed.cabinetResult as CabinetResult | null;
  if (!cabinetResult) {
    const response =
      await getCabinetReportIdentityClient().deleteUnattachedPerson({
        operationId: claimed.operationId,
        email,
      });
    if (response.status === "refused") return "pending";
    cabinetResult = response.status;
    const stored = await getDatabase()
      .db.update(scannerIdentityDeletionOperations)
      .set({ cabinetResult })
      .where(
        and(
          eq(
            scannerIdentityDeletionOperations.operationId,
            claimed.operationId,
          ),
          eq(scannerIdentityDeletionOperations.leaseToken, claimed.leaseToken),
          isNull(scannerIdentityDeletionOperations.cabinetResult),
          isNull(scannerIdentityDeletionOperations.completedAt),
        ),
      )
      .returning({
        operationId: scannerIdentityDeletionOperations.operationId,
      });
    if (!stored.length) return "pending";
  }

  const extended = await getDatabase()
    .db.update(scannerIdentityDeletionOperations)
    .set({ leaseExpiresAt: new Date(Date.now() + PROVIDER_LEASE_MS) })
    .where(
      and(
        eq(scannerIdentityDeletionOperations.operationId, claimed.operationId),
        eq(scannerIdentityDeletionOperations.leaseToken, claimed.leaseToken),
        isNull(scannerIdentityDeletionOperations.completedAt),
      ),
    )
    .returning({ operationId: scannerIdentityDeletionOperations.operationId });
  if (!extended.length) return "pending";

  await detachLeadCardSignalsForDeletion(claimed.leadId, input.provider);
  const now = new Date();
  const anonymized = await anonymizeLeadData(
    getDatabase().db,
    claimed.leadId,
    now,
    async (tx, leadId) => {
      const operation = (
        await tx
          .select({
            cabinetResult: scannerIdentityDeletionOperations.cabinetResult,
            leaseExpiresAt: scannerIdentityDeletionOperations.leaseExpiresAt,
          })
          .from(scannerIdentityDeletionOperations)
          .where(
            and(
              eq(
                scannerIdentityDeletionOperations.operationId,
                claimed.operationId,
              ),
              eq(scannerIdentityDeletionOperations.leadId, leadId),
              eq(
                scannerIdentityDeletionOperations.leaseToken,
                claimed.leaseToken,
              ),
              isNull(scannerIdentityDeletionOperations.completedAt),
            ),
          )
          .limit(1)
          .for("update")
      )[0];
      if (
        !operation?.cabinetResult ||
        !operation.leaseExpiresAt ||
        operation.leaseExpiresAt.getTime() <= now.getTime()
      ) {
        throw new Error("scanner_deletion_lease_lost");
      }
      await tx
        .delete(scannerRecoveryIntents)
        .where(eq(scannerRecoveryIntents.leadId, leadId));
      await tx
        .delete(scannerIdentityCompletions)
        .where(eq(scannerIdentityCompletions.leadId, leadId));
      const finished = await tx
        .update(scannerIdentityDeletionOperations)
        .set({ completedAt: now, leaseToken: null, leaseExpiresAt: null })
        .where(
          and(
            eq(
              scannerIdentityDeletionOperations.operationId,
              claimed.operationId,
            ),
            eq(
              scannerIdentityDeletionOperations.leaseToken,
              claimed.leaseToken,
            ),
            isNull(scannerIdentityDeletionOperations.completedAt),
          ),
        )
        .returning({
          operationId: scannerIdentityDeletionOperations.operationId,
        });
      if (!finished.length) throw new Error("scanner_deletion_lease_lost");
    },
  );
  return anonymized.status === "anonymized" ? "completed" : "pending";
}

export async function requestScannerIdentityDeletion(input: {
  leadId: string;
  provider?: StripeCardSignalProvider;
}): Promise<"requested" | "completed"> {
  const operation = await beginScannerIdentityDeletion(input.leadId);
  if (operation.completedAt) return "completed";
  try {
    const result = await runScannerIdentityDeletionOperation({
      operationId: operation.operationId,
      provider: input.provider,
    });
    return result === "completed" ? "completed" : "requested";
  } catch {
    return "requested";
  }
}

let retryRunning = false;

export async function retryPendingScannerIdentityDeletions(): Promise<number> {
  if (retryRunning) return 0;
  retryRunning = true;
  let completed = 0;
  try {
    for (let index = 0; index < RETRY_BATCH_SIZE; index += 1) {
      const result = await runScannerIdentityDeletionOperation();
      if (result === "not_found") break;
      if (result === "completed") completed += 1;
    }
    return completed;
  } finally {
    retryRunning = false;
  }
}
