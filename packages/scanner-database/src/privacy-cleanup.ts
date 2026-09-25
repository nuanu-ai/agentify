import { and, asc, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";

import type { Database, DatabaseTransaction } from "./client.js";
import { createUuidV7 } from "./ids.js";
import {
  analyticsEvents,
  browserObservationFindings,
  browserObservations,
  deliveryOutbox,
  leadScans,
  leads,
  merchantApplications,
  paymentSignals,
  rateLimitEvents,
  rateWindows,
  registrationIntents,
  scanChecks,
  scanShares,
  scanSnapshots,
  scans,
  sessions,
  waitlistEntries,
} from "./schema.js";

export const REGISTRATION_INTENT_RETENTION_MS = 7 * 86_400_000;
export const UNVERIFIED_LEAD_RETENTION_MS = 30 * 86_400_000;

export async function deleteExpiredMerchantApplications(db: Database, now = new Date()) {
  const deleted = await db
    .delete(merchantApplications)
    .where(lt(merchantApplications.expiresAt, now))
    .returning({ id: merchantApplications.id });
  return deleted.length;
}

export async function listUnverifiedLeadRetentionCandidates(
  db: Database,
  input: { now?: Date; limit?: number } = {},
) {
  const cutoff = new Date((input.now ?? new Date()).getTime() - UNVERIFIED_LEAD_RETENTION_MS);
  return await db
    .select({ id: leads.id, createdAt: leads.createdAt })
    .from(leads)
    .where(and(isNull(leads.verifiedAt), isNull(leads.anonymizedAt), lt(leads.createdAt, cutoff)))
    .orderBy(asc(leads.createdAt))
    .limit(Math.min(1_000, Math.max(1, input.limit ?? 100)));
}

export async function deleteRetainedRegistrationIntents(db: Database, now = new Date()) {
  const cutoff = new Date(now.getTime() - REGISTRATION_INTENT_RETENTION_MS);
  const removed = await db
    .delete(registrationIntents)
    .where(
      sql`coalesce(${registrationIntents.consumedAt}, ${registrationIntents.expiresAt}) < ${cutoff}`,
    )
    .returning({ id: registrationIntents.id });
  return removed.length;
}

export async function deleteExpiredRateLimitState(db: Database, now = new Date()) {
  const [events, windows] = await Promise.all([
    db
      .delete(rateLimitEvents)
      .where(sql`${rateLimitEvents.expiresAt} <= ${now}`)
      .returning({ id: rateLimitEvents.id }),
    db
      .delete(rateWindows)
      .where(sql`${rateWindows.expiresAt} <= ${now}`)
      .returning({ keyHash: rateWindows.keyHash }),
  ]);
  return events.length + windows.length;
}

export async function anonymizeLeadData(
  db: Database,
  leadId: string,
  now = new Date(),
  beforeAnonymizeInTransaction?: (tx: DatabaseTransaction, leadId: string) => Promise<void>,
  retentionCutoff?: Date,
) {
  return await db.transaction(async (tx) => {
    if (beforeAnonymizeInTransaction) {
      const pending = await tx
        .select({ emailLookupHash: leads.emailLookupHash })
        .from(leads)
        .where(eq(leads.id, leadId))
        .limit(1);
      if (pending[0])
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${pending[0].emailLookupHash}, 0))`,
        );
    }
    const locked = await tx.execute<{
      id: string;
      email_lookup_hash: string;
      anonymized_at: Date | null;
      verified_at: Date | null;
      created_at: Date;
    }>(
      sql`select id, email_lookup_hash, anonymized_at, verified_at, created_at from leads where id = ${leadId} for update`,
    );
    const lead = locked.rows[0];
    if (!lead) return { status: "not_found" as const, scanCount: 0 };
    if (lead.anonymized_at) return { status: "already_anonymized" as const, scanCount: 0 };
    if (retentionCutoff && (lead.verified_at || lead.created_at >= retentionCutoff))
      return { status: "no_longer_eligible" as const, scanCount: 0 };
    if (beforeAnonymizeInTransaction) await beforeAnonymizeInTransaction(tx, leadId);

    const linkedRows = await tx
      .select({ scanId: leadScans.scanId })
      .from(leadScans)
      .where(eq(leadScans.leadId, leadId));
    const directRows = await tx
      .select({ scanId: scans.id })
      .from(scans)
      .where(eq(scans.leadId, leadId));
    const scanIds = [...new Set([...linkedRows, ...directRows].map(({ scanId }) => scanId))];
    const ownedScans = scanIds.length
      ? await tx
          .select({
            id: scans.id,
            canonicalTargetUrl: scans.canonicalTargetUrl,
          })
          .from(scans)
          .where(inArray(scans.id, scanIds))
      : [];
    const ownedTargetUrls = [
      ...new Set(ownedScans.map(({ canonicalTargetUrl }) => canonicalTargetUrl)),
    ];
    const anonymizedSessionId = createUuidV7();
    await tx.insert(sessions).values({
      id: anonymizedSessionId,
      anonymousIdHash: `deleted:session:${anonymizedSessionId}`,
    });

    await tx
      .delete(registrationIntents)
      .where(eq(registrationIntents.emailLookupHash, lead.email_lookup_hash));
    await tx.delete(waitlistEntries).where(eq(waitlistEntries.leadId, leadId));

    const leadEventIds = tx
      .select({ eventId: analyticsEvents.eventId })
      .from(analyticsEvents)
      .where(
        scanIds.length
          ? or(eq(analyticsEvents.leadId, leadId), inArray(analyticsEvents.scanId, scanIds))
          : eq(analyticsEvents.leadId, leadId),
      );
    await tx.delete(deliveryOutbox).where(inArray(deliveryOutbox.eventId, leadEventIds));
    await tx
      .update(analyticsEvents)
      .set({ leadId: null, sessionId: anonymizedSessionId })
      .where(
        scanIds.length
          ? or(eq(analyticsEvents.leadId, leadId), inArray(analyticsEvents.scanId, scanIds))
          : eq(analyticsEvents.leadId, leadId),
      );

    await tx.delete(paymentSignals).where(eq(paymentSignals.leadId, leadId));

    if (scanIds.length) {
      const observationIds = tx
        .select({ id: browserObservations.id })
        .from(browserObservations)
        .where(inArray(browserObservations.scanId, scanIds));
      await tx
        .update(browserObservationFindings)
        .set({ evidence: { anonymized: true } })
        .where(inArray(browserObservationFindings.observationId, observationIds));
      await tx
        .update(browserObservations)
        .set({ signals: null, failureCode: "data_anonymized", updatedAt: now })
        .where(inArray(browserObservations.scanId, scanIds));
      await tx
        .delete(scanSnapshots)
        .where(
          ownedTargetUrls.length
            ? or(
                inArray(scanSnapshots.id, scanIds),
                inArray(scanSnapshots.canonicalTargetUrl, ownedTargetUrls),
              )
            : inArray(scanSnapshots.id, scanIds),
        );
      await tx
        .update(scanShares)
        .set({
          status: "revoked",
          revokedAt: now,
          publicSnapshot: { anonymized: true },
          allowIndexing: false,
        })
        .where(inArray(scanShares.scanId, scanIds));
      await tx
        .update(scanChecks)
        .set({ evidence: { anonymized: true } })
        .where(inArray(scanChecks.scanId, scanIds));
      await tx
        .update(scans)
        .set({
          leadId: null,
          sessionId: anonymizedSessionId,
          submittedUrlRedacted: "redacted://deleted",
          canonicalTargetUrl: "redacted://deleted",
          targetHost: "deleted.invalid",
          targetHash: sql`'deleted:' || ${scans.id}::text`,
          accessTokenHash: sql`'deleted:' || ${scans.id}::text`,
          accessTokenExpiresAt: now,
        })
        .where(or(inArray(scans.id, scanIds), eq(scans.leadId, leadId)));
    } else {
      await tx
        .update(scans)
        .set({ leadId: null, accessTokenExpiresAt: now })
        .where(eq(scans.leadId, leadId));
    }
    await tx.delete(leadScans).where(eq(leadScans.leadId, leadId));
    await tx
      .update(leads)
      .set({
        supabaseUserId: null,
        emailNormalizedCiphertext: "deleted",
        emailLookupHash: `deleted:${leadId}`,
        phoneE164Ciphertext: null,
        phoneLookupHash: null,
        role: "deleted",
        name: null,
        volumeBucket: null,
        verifiedAt: null,
        unsubscribedAt: now,
        deletionRequestedAt: now,
        dataAccessRequestedAt: null,
        anonymizedAt: now,
        firstSessionId: anonymizedSessionId,
      })
      .where(eq(leads.id, leadId));
    return { status: "anonymized" as const, scanCount: scanIds.length };
  });
}

export async function runRetentionCleanup(
  db: Database,
  input: {
    beforeLeadAnonymize: (leadId: string) => Promise<void>;
    now?: Date;
    batchSize?: number;
  },
) {
  const now = input.now ?? new Date();
  const merchantApplicationsDeleted = await deleteExpiredMerchantApplications(db, now);
  const registrationIntentsDeleted = await deleteRetainedRegistrationIntents(db, now);
  const rateLimitRowsDeleted = await deleteExpiredRateLimitState(db, now);
  const candidates = await listUnverifiedLeadRetentionCandidates(db, {
    now,
    limit: input.batchSize,
  });
  let leadsAnonymized = 0;
  for (const candidate of candidates) {
    await input.beforeLeadAnonymize(candidate.id);
    const result = await anonymizeLeadData(
      db,
      candidate.id,
      now,
      undefined,
      new Date(now.getTime() - UNVERIFIED_LEAD_RETENTION_MS),
    );
    if (result.status === "anonymized") leadsAnonymized += 1;
  }
  return {
    merchantApplicationsDeleted,
    registrationIntentsDeleted,
    rateLimitRowsDeleted,
    leadsAnonymized,
    candidatesProcessed: candidates.length,
  } as const;
}
