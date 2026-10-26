/**
 * A person's request for a copy of the data held about their address. The
 * route records it for the address the person is signed in as, which is the
 * proof that the address is theirs, and makes the first try while they wait:
 * the scanner gathers what its own database holds, and the dashboard adds
 * what it holds and mails the whole to that address. A try that fails is made
 * again on a fixed schedule by the background retry; once every try has
 * failed, the request is failed and the operator's page counts it.
 *
 * The address is the one value that decides both whose data is gathered and
 * where it is mailed, so a copy can reach nobody but the person it describes.
 */

import {
  analyticsEvents,
  consentSnapshots,
  createUuidV7,
  dataCopyRequests,
  deliveryOutbox,
  leadScans,
  leads,
  registrationIntents,
  scanChecks,
  scanShares,
  scans,
  sessions,
  waitlistEntries,
} from "@agentify/scanner-database";
import { and, asc, count, desc, eq, gt, inArray, isNull, lt, lte, or, sql } from "drizzle-orm";
import { PRIVACY_RETRY_INTERVAL_MS } from "../../server/privacy-retries";
import { getServerConfig } from "./config";
import { decryptSensitiveValue, encryptSensitiveValue, hmacHex, normalizeEmail } from "./crypto";
import { getDashboardReportIdentityClient } from "./dashboard-report-identity";
import { getDatabase } from "./database";

/**
 * How long after each failed try the next one is made. Once the last of these
 * has passed and its try failed too, the request has failed: five tries in
 * all, the last within an hour of the first.
 */
export const COPY_RETRY_DELAYS_MS = [60_000, 5 * 60_000, 15 * 60_000, 30 * 60_000] as const;
/** A copy mailed this recently answers a second press, instead of a second copy. */
const RECENT_COPY_MS = 10 * 60_000;
/** Longer than a try takes: the dashboard is given thirty seconds to answer. */
const CLAIM_LEASE_MS = 2 * 60_000;
const RETRY_BATCH_SIZE = 10;

/** The most of each list the scanner's part carries; each list says how many there are. */
const SCANNER_COPY_ROWS_MAX = { reports: 200, analyticsEvents: 1_000, requests: 50 };

type Request = typeof dataCopyRequests.$inferSelect;

/** What a press is told, from the request as it stands once the press is done. */
export type CopyAnswer =
  | Readonly<{ status: "sent"; sentAt: Date; fresh: boolean }>
  /**
   * Tries remain. `outcome` is how the last one ended, or `in_progress` while
   * one is being made; `lastTryBy` is when the last try will have been made.
   */
  | Readonly<{
      status: "pending";
      outcome: "refused" | "no_answer" | "in_progress";
      lastTryBy: Date;
    }>
  | Readonly<{ status: "failed" }>;

const iso = (value: Date | null): string | null => (value === null ? null : value.toISOString());

const addressHash = (email: string): string =>
  hmacHex(getServerConfig().hmacSecret, "email", normalizeEmail(email));

/**
 * When the last try of a request still pending will have been made: its next
 * try, the delays after that one, and one turn of the background retry.
 */
function lastTryBy(request: Request): Date {
  const next = request.nextAttemptAt?.getTime() ?? Date.now();
  const after = COPY_RETRY_DELAYS_MS.slice(request.attempts).reduce((sum, delay) => sum + delay, 0);
  return new Date(next + after + PRIVACY_RETRY_INTERVAL_MS);
}

function answerOf(request: Request, pressedAt: Date): CopyAnswer {
  if (request.state === "sent" && request.settledAt !== null)
    return {
      status: "sent",
      sentAt: request.settledAt,
      fresh: request.settledAt.getTime() >= pressedAt.getTime(),
    };
  if (request.state === "failed") return { status: "failed" };
  const leased = request.leaseExpiresAt !== null && request.leaseExpiresAt.getTime() > Date.now();
  return {
    status: "pending",
    outcome:
      leased || request.lastOutcome === null
        ? "in_progress"
        : (request.lastOutcome as "refused" | "no_answer"),
    lastTryBy: lastTryBy(request),
  };
}

/**
 * The request a press stands for: the one still pending for this address, a
 * copy mailed in the last ten minutes, or a new one, decided under the
 * address's lock so two presses at once make one request.
 */
async function requestFor(email: string, now: Date): Promise<Request> {
  const hash = addressHash(email);
  return await getDatabase().db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`data-copy:${hash}`}, 0))`,
    );
    const [standing] = await tx
      .select()
      .from(dataCopyRequests)
      .where(
        and(
          eq(dataCopyRequests.emailLookupHash, hash),
          or(
            eq(dataCopyRequests.state, "pending"),
            and(
              eq(dataCopyRequests.state, "sent"),
              gt(dataCopyRequests.settledAt, new Date(now.getTime() - RECENT_COPY_MS)),
            ),
          ),
        ),
      )
      .orderBy(desc(dataCopyRequests.requestedAt))
      .limit(1);
    if (standing !== undefined) return standing;
    const [made] = await tx
      .insert(dataCopyRequests)
      .values({
        id: createUuidV7(),
        emailLookupHash: hash,
        emailNormalizedCiphertext: encryptSensitiveValue(
          normalizeEmail(email),
          getServerConfig().encryptionKey,
        ),
        state: "pending",
        requestedAt: now,
        nextAttemptAt: now,
      })
      .returning();
    if (made === undefined)
      throw new Error("the copy request this transaction wrote was not read back");
    return made;
  });
}

/** Takes one due request no other try holds, for one try; `id` names the one to take. */
async function claim(id?: string): Promise<(Request & { leaseToken: string }) | undefined> {
  return await getDatabase().db.transaction(async (tx) => {
    const now = new Date();
    const [due] = await tx
      .select()
      .from(dataCopyRequests)
      .where(
        and(
          ...(id === undefined ? [] : [eq(dataCopyRequests.id, id)]),
          eq(dataCopyRequests.state, "pending"),
          lte(dataCopyRequests.nextAttemptAt, now),
          or(isNull(dataCopyRequests.leaseExpiresAt), lt(dataCopyRequests.leaseExpiresAt, now)),
        ),
      )
      .orderBy(asc(dataCopyRequests.nextAttemptAt))
      .limit(1)
      .for("update", { skipLocked: true });
    if (due === undefined) return undefined;
    const leaseToken = createUuidV7();
    await tx
      .update(dataCopyRequests)
      .set({ leaseToken, leaseExpiresAt: new Date(now.getTime() + CLAIM_LEASE_MS) })
      .where(eq(dataCopyRequests.id, due.id));
    return { ...due, leaseToken };
  });
}

/** Writes how a try ended, if this try still holds the request. */
async function settleTry(
  claimed: Request & { leaseToken: string },
  ended: "sent" | "refused" | "no_answer",
): Promise<void> {
  const now = new Date();
  const attempts = claimed.attempts + 1;
  const delay = COPY_RETRY_DELAYS_MS[attempts - 1];
  const finished = ended === "sent" || delay === undefined;
  await getDatabase()
    .db.update(dataCopyRequests)
    .set({
      attempts,
      leaseToken: null,
      leaseExpiresAt: null,
      lastOutcome: ended === "sent" ? null : ended,
      ...(finished
        ? {
            state: ended === "sent" ? "sent" : "failed",
            settledAt: now,
            nextAttemptAt: null,
            emailNormalizedCiphertext: null,
          }
        : { nextAttemptAt: new Date(now.getTime() + delay) }),
    })
    .where(
      and(
        eq(dataCopyRequests.id, claimed.id),
        eq(dataCopyRequests.leaseToken, claimed.leaseToken),
        eq(dataCopyRequests.state, "pending"),
      ),
    );
}

/**
 * One try of one due request, or of the one named: gathers the scanner's part
 * and asks the dashboard to mail the copy. `none` where nothing was due.
 */
export async function runDataCopy(
  input: { id?: string } = {},
): Promise<"sent" | "refused" | "no_answer" | "none"> {
  const claimed = await claim(input.id);
  if (claimed === undefined) return "none";
  let ended: "sent" | "refused" | "no_answer";
  try {
    const config = getServerConfig();
    const email = normalizeEmail(
      decryptSensitiveValue(claimed.emailNormalizedCiphertext ?? "", config.encryptionKey),
    );
    if (addressHash(email) !== claimed.emailLookupHash)
      throw new Error("data_copy_address_mismatch");
    const answered = await getDashboardReportIdentityClient().sendDataCopy({
      request: claimed.id,
      email,
      scanner: await scannerCopyOf(email),
    });
    ended = answered.status === "accepted" ? "sent" : "refused";
  } catch {
    // The dashboard may have mailed the copy before its answer was lost, so a
    // repeat can deliver a second one; that is the cost of not losing one.
    ended = "no_answer";
  }
  await settleTry(claimed, ended);
  return ended;
}

/** Asks for a copy for the address signed in as `email`, and makes its first try now. */
export async function requestDataCopy(email: string): Promise<CopyAnswer> {
  const pressedAt = new Date();
  const request = await requestFor(email, pressedAt);
  if (request.state === "pending") await runDataCopy({ id: request.id });
  const [now] = await getDatabase()
    .db.select()
    .from(dataCopyRequests)
    .where(eq(dataCopyRequests.id, request.id));
  // A deletion of the address in between removes the request with everything else.
  if (now === undefined) return { status: "failed" };
  return answerOf(now, pressedAt);
}

let retryRunning = false;

/** The background retry's turn: the requests whose next try is due, a batch at a time. */
export async function retryDueDataCopies(): Promise<number> {
  if (retryRunning) return 0;
  retryRunning = true;
  let sent = 0;
  try {
    for (let index = 0; index < RETRY_BATCH_SIZE; index += 1) {
      const ended = await runDataCopy();
      if (ended === "none") break;
      if (ended === "sent") sent += 1;
    }
    return sent;
  } finally {
    retryRunning = false;
  }
}

/**
 * What the scanner's database holds for this address, as the copy carries it.
 * The person's reports are the scans their lead is linked to; a scan's own
 * session is left out, because whoever submitted the site may be somebody
 * else. The visits are the lead's first session and those of its own events.
 */
async function scannerCopyOf(email: string): Promise<Record<string, unknown>> {
  const { db } = getDatabase();
  const config = getServerConfig();
  const hash = addressHash(email);
  const decrypted = (value: string | null): string | null =>
    value === null ? null : decryptSensitiveValue(value, config.encryptionKey);
  const [lead] = await db
    .select()
    .from(leads)
    .where(
      and(
        eq(leads.emailLookupHash, hash),
        isNull(leads.anonymizedAt),
        isNull(leads.deletionRequestedAt),
      ),
    )
    .limit(1);
  const intents = await db
    .select()
    .from(registrationIntents)
    .where(eq(registrationIntents.emailLookupHash, hash))
    .orderBy(desc(registrationIntents.createdAt));
  const asked = await db
    .select({
      requestedAt: dataCopyRequests.requestedAt,
      state: dataCopyRequests.state,
      settledAt: dataCopyRequests.settledAt,
    })
    .from(dataCopyRequests)
    .where(eq(dataCopyRequests.emailLookupHash, hash))
    .orderBy(desc(dataCopyRequests.requestedAt))
    .limit(SCANNER_COPY_ROWS_MAX.requests);
  const base = {
    address: normalizeEmail(email),
    left_out: [
      "The evidence each check gathered about your website, which the report itself shows at its report_url.",
      "The browser session that submitted a scan, which can be somebody else's: anyone can scan any site.",
      `Reports beyond the newest ${SCANNER_COPY_ROWS_MAX.reports} and analytics events beyond the newest ${SCANNER_COPY_ROWS_MAX.analyticsEvents.toLocaleString("en-US")}; each list's "total" says how many there are in all.`,
    ],
    registrations: intents.map((intent) => ({
      scan_id: intent.scanId,
      role: intent.role,
      phone: decrypted(intent.phoneE164Ciphertext),
      site_ownership_claim: intent.siteOwnershipClaim,
      marketing_email_opt_in: intent.marketingEmailOptIn,
      dataset_reuse_acknowledged: intent.datasetReuseAcknowledged,
      asked_at: iso(intent.createdAt),
      expires_at: iso(intent.expiresAt),
      used_at: iso(intent.consumedAt),
    })),
    data_requests: asked.map((one) => ({
      requested_at: iso(one.requestedAt),
      state: one.state,
      settled_at: iso(one.settledAt),
    })),
  };
  if (lead === undefined) return { ...base, lead: null };

  const [{ reportTotal } = { reportTotal: 0 }] = await db
    .select({ reportTotal: count() })
    .from(leadScans)
    .where(eq(leadScans.leadId, lead.id));
  const owned = await db
    .select({
      scan: scans,
      ownershipClaim: leadScans.siteOwnershipClaim,
      linkedAt: leadScans.createdAt,
      registeredAt: waitlistEntries.createdAt,
    })
    .from(leadScans)
    .innerJoin(scans, eq(scans.id, leadScans.scanId))
    .leftJoin(
      waitlistEntries,
      and(eq(waitlistEntries.scanId, leadScans.scanId), eq(waitlistEntries.leadId, lead.id)),
    )
    .where(eq(leadScans.leadId, lead.id))
    .orderBy(desc(scans.acceptedAt))
    .limit(SCANNER_COPY_ROWS_MAX.reports);
  const scanIds = owned.map(({ scan }) => scan.id);
  const checks = scanIds.length
    ? await db
        .select({
          scanId: scanChecks.scanId,
          checkId: scanChecks.checkId,
          status: scanChecks.status,
          summaryCode: scanChecks.summaryCode,
          fixCode: scanChecks.fixCode,
        })
        .from(scanChecks)
        .where(inArray(scanChecks.scanId, scanIds))
        .orderBy(asc(scanChecks.checkId))
    : [];
  const shares = scanIds.length
    ? await db
        .select({
          scanId: scanShares.scanId,
          status: scanShares.status,
          publishedAt: scanShares.publishedAt,
          revokedAt: scanShares.revokedAt,
          allowIndexing: scanShares.allowIndexing,
        })
        .from(scanShares)
        .where(inArray(scanShares.scanId, scanIds))
    : [];

  const [{ eventTotal } = { eventTotal: 0 }] = await db
    .select({ eventTotal: count() })
    .from(analyticsEvents)
    .where(eq(analyticsEvents.leadId, lead.id));
  const events = await db
    .select({
      eventId: analyticsEvents.eventId,
      name: analyticsEvents.name,
      occurredAt: analyticsEvents.occurredAt,
      sessionId: analyticsEvents.sessionId,
      scanId: analyticsEvents.scanId,
      segment: analyticsEvents.segment,
      landingVariant: analyticsEvents.landingVariant,
      properties: analyticsEvents.properties,
    })
    .from(analyticsEvents)
    .where(eq(analyticsEvents.leadId, lead.id))
    .orderBy(desc(analyticsEvents.occurredAt))
    .limit(SCANNER_COPY_ROWS_MAX.analyticsEvents);
  const deliveries = events.length
    ? await db
        .select({
          eventId: deliveryOutbox.eventId,
          destination: deliveryOutbox.destination,
          status: deliveryOutbox.status,
          deliveredAt: deliveryOutbox.deliveredAt,
        })
        .from(deliveryOutbox)
        .where(
          inArray(
            deliveryOutbox.eventId,
            events.map((event) => event.eventId),
          ),
        )
    : [];
  const sessionIds = [...new Set([lead.firstSessionId, ...events.map((event) => event.sessionId)])];
  // A session's identifier joins the site's own records and tells the person
  // nothing, so the copy numbers the visits instead.
  const visitOf = (sessionId: string) => `visit-${sessionIds.indexOf(sessionId) + 1}`;
  const visits = await db.select().from(sessions).where(inArray(sessions.id, sessionIds));
  const consents = await db
    .select()
    .from(consentSnapshots)
    .where(inArray(consentSnapshots.sessionId, sessionIds))
    .orderBy(asc(consentSnapshots.capturedAt));

  return {
    ...base,
    lead: {
      email: normalizeEmail(email),
      phone: decrypted(lead.phoneE164Ciphertext),
      role: lead.role,
      first_segment: lead.firstSegment,
      created_at: iso(lead.createdAt),
      verified_at: iso(lead.verifiedAt),
      unsubscribed_from_marketing_at: iso(lead.unsubscribedAt),
    },
    reports: {
      total: reportTotal,
      rows: owned.map(({ scan, ownershipClaim, linkedAt, registeredAt }) => ({
        scan_id: scan.id,
        report_url: `${config.appBaseUrl}/report/${scan.id}`,
        site: scan.canonicalTargetUrl,
        submitted_url: scan.submittedUrlRedacted,
        segment: scan.segment,
        status: scan.status,
        score: scan.score,
        level: scan.level,
        coverage: scan.coverage,
        rubric_version: scan.rubricVersion,
        accepted_at: iso(scan.acceptedAt),
        finished_at: iso(scan.finishedAt),
        site_ownership_claim: ownershipClaim,
        linked_at: iso(linkedAt),
        registered_at: iso(registeredAt),
        checks: checks
          .filter((check) => check.scanId === scan.id)
          .map((check) => ({
            check_id: check.checkId,
            status: check.status,
            summary_code: check.summaryCode,
            fix_code: check.fixCode,
          })),
        shares: shares
          .filter((share) => share.scanId === scan.id)
          .map((share) => ({
            status: share.status,
            published_at: iso(share.publishedAt),
            revoked_at: iso(share.revokedAt),
            search_engines_may_index: share.allowIndexing,
          })),
      })),
    },
    visits: visits.map((visit) => ({
      visit: visitOf(visit.id),
      first_seen_at: iso(visit.createdAt),
      last_seen_at: iso(visit.lastSeenAt),
      first_landing: {
        variant: visit.firstLandingVariant,
        utm_source: visit.firstUtmSource,
        utm_medium: visit.firstUtmMedium,
        utm_campaign: visit.firstUtmCampaign,
        utm_content: visit.firstUtmContent,
        utm_term: visit.firstUtmTerm,
      },
      last_landing: {
        variant: visit.lastLandingVariant,
        utm_source: visit.lastUtmSource,
        utm_medium: visit.lastUtmMedium,
        utm_campaign: visit.lastUtmCampaign,
        utm_content: visit.lastUtmContent,
        utm_term: visit.lastUtmTerm,
      },
      privacy_choices: consents
        .filter((consent) => consent.sessionId === visit.id)
        .map((consent) => ({
          policy_version: consent.policyVersion,
          categories: consent.categories,
          source: consent.source,
          captured_at: iso(consent.capturedAt),
        })),
    })),
    analytics_events: {
      total: eventTotal,
      rows: events.map((event) => ({
        name: event.name,
        occurred_at: iso(event.occurredAt),
        visit: visitOf(event.sessionId),
        scan_id: event.scanId,
        segment: event.segment,
        landing_variant: event.landingVariant,
        properties: event.properties,
        sent_to: deliveries
          .filter((delivery) => delivery.eventId === event.eventId)
          .map((delivery) => ({
            destination: delivery.destination,
            status: delivery.status,
            delivered_at: iso(delivery.deliveredAt),
          })),
      })),
    },
  };
}
