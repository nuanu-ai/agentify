import { and, asc, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";

import type { Database, DatabaseTransaction } from "./client.js";
import { createUuidV7 } from "./ids.js";
import {
  analyticsEvents,
  browserObservationFindings,
  browserObservations,
  dataCopyRequests,
  deliveryOutbox,
  leadScans,
  leads,
  rateLimitEvents,
  rateWindows,
  registrationIntents,
  scanChecks,
  scanShares,
  scans,
  sessions,
  waitlistEntries,
} from "./schema.js";

/** What a scan's address reads once the person behind the scan is deleted. */
export const DELETED_TARGET_URL = "redacted://deleted";

const REGISTRATION_INTENT_RETENTION_MS = 7 * 86_400_000;
const UNVERIFIED_LEAD_RETENTION_MS = 30 * 86_400_000;
const RAW_ANALYTICS_EVENT_RETENTION_MS = 13 * 30 * 86_400_000;
const RAW_ANALYTICS_EVENT_DELETE_BATCH = 1_000;

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

async function deleteRetainedRegistrationIntents(db: Database, now = new Date()) {
  const cutoff = new Date(now.getTime() - REGISTRATION_INTENT_RETENTION_MS);
  const removed = await db
    .delete(registrationIntents)
    .where(
      sql`coalesce(${registrationIntents.consumedAt}, ${registrationIntents.expiresAt}) < ${cutoff}`,
    )
    .returning({ id: registrationIntents.id });
  return removed.length;
}

async function deleteExpiredRateLimitState(db: Database, now = new Date()) {
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

const analyticsEventRetentionCutoff = (now: Date) =>
  new Date(now.getTime() - RAW_ANALYTICS_EVENT_RETENTION_MS);

/** How many raw analytics events the retention cleanup would delete at `now`. */
export async function countRetainedAnalyticsEvents(db: Database, now = new Date()) {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(analyticsEvents)
    .where(lt(analyticsEvents.occurredAt, analyticsEventRetentionCutoff(now)));
  return row?.count ?? 0;
}

/**
 * Deletes in bounds so no single statement holds a long lock on the events
 * table, and repeats until nothing overdue is left, since the cleanup runs once
 * a night. An event's sends in the delivery outbox go with it by cascade.
 */
async function deleteRetainedAnalyticsEvents(db: Database, now: Date) {
  const cutoff = analyticsEventRetentionCutoff(now);
  let deleted = 0;
  for (;;) {
    const overdue = db
      .select({ id: analyticsEvents.id })
      .from(analyticsEvents)
      .where(lt(analyticsEvents.occurredAt, cutoff))
      .limit(RAW_ANALYTICS_EVENT_DELETE_BATCH);
    const removed = await db
      .delete(analyticsEvents)
      .where(inArray(analyticsEvents.id, overdue))
      .returning({ id: analyticsEvents.id });
    deleted += removed.length;
    if (removed.length < RAW_ANALYTICS_EVENT_DELETE_BATCH) return deleted;
  }
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
    const anonymizedSessionId = createUuidV7();
    await tx.insert(sessions).values({
      id: anonymizedSessionId,
      anonymousIdHash: `deleted:session:${anonymizedSessionId}`,
    });

    await tx
      .delete(registrationIntents)
      .where(eq(registrationIntents.emailLookupHash, lead.email_lookup_hash));
    await tx
      .delete(dataCopyRequests)
      .where(eq(dataCopyRequests.emailLookupHash, lead.email_lookup_hash));
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
        .set({ failureCode: "data_anonymized", updatedAt: now })
        .where(inArray(browserObservations.scanId, scanIds));
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
          submittedUrlRedacted: DELETED_TARGET_URL,
          canonicalTargetUrl: DELETED_TARGET_URL,
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
        emailNormalizedCiphertext: "deleted",
        emailLookupHash: `deleted:${leadId}`,
        phoneE164Ciphertext: null,
        phoneLookupHash: null,
        role: "deleted",
        verifiedAt: null,
        unsubscribedAt: now,
        deletionRequestedAt: now,
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
    now?: Date;
    batchSize?: number;
  },
) {
  const now = input.now ?? new Date();
  const registrationIntentsDeleted = await deleteRetainedRegistrationIntents(db, now);
  const rateLimitRowsDeleted = await deleteExpiredRateLimitState(db, now);
  const candidates = await listUnverifiedLeadRetentionCandidates(db, {
    now,
    limit: input.batchSize,
  });
  let leadsAnonymized = 0;
  for (const candidate of candidates) {
    const result = await anonymizeLeadData(
      db,
      candidate.id,
      now,
      undefined,
      new Date(now.getTime() - UNVERIFIED_LEAD_RETENTION_MS),
    );
    if (result.status === "anonymized") leadsAnonymized += 1;
  }
  const analyticsEventsDeleted = await deleteRetainedAnalyticsEvents(db, now);
  return {
    registrationIntentsDeleted,
    rateLimitRowsDeleted,
    analyticsEventsDeleted,
    leadsAnonymized,
    candidatesProcessed: candidates.length,
  } as const;
}
