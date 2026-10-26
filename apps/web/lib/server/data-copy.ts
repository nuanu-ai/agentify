/**
 * A person's request for a copy of the data held about their address. The
 * route records it for the address the person is signed in as, which is the
 * proof that the address is theirs, and makes the first try while they wait:
 * the scanner gathers what its own database holds, and the dashboard adds
 * what it holds and mails the whole to that address. A try that fails is made
 * again on a fixed schedule by the background retry; once every try has
 * failed, the request has given up and the operator's page counts it.
 *
 * The address is the one value that decides both whose data is gathered and
 * where it is mailed, so a copy can reach nobody but the person it describes.
 */

import {
  analyticsEvents,
  createUuidV7,
  dataCopyRequests,
  deliveryOutbox,
  leadScans,
  leads,
  registrationIntents,
  scanChecks,
  scanShares,
  scans,
  waitlistEntries,
} from "@agentify/scanner-database";
import { and, asc, count, desc, eq, gt, inArray, isNull, lt, lte, ne, or, sql } from "drizzle-orm";
import { PRIVACY_RETRY_INTERVAL_MS } from "../../server/privacy-retries";
import { getServerConfig } from "./config";
import { decryptSensitiveValue, encryptSensitiveValue, hmacHex, normalizeEmail } from "./crypto";
import {
  DATA_COPY_TIMEOUT_MS,
  DashboardRequestTooLarge,
  getDashboardReportIdentityClient,
} from "./dashboard-report-identity";
import { getDatabase } from "./database";

/**
 * How long after each failed try the next one is made. Once the last of these
 * has passed and its try failed too, the request has given up: five tries in
 * all.
 */
export const COPY_RETRY_DELAYS_MS = [60_000, 5 * 60_000, 15 * 60_000, 30 * 60_000] as const;
const COPY_TRIES = COPY_RETRY_DELAYS_MS.length + 1;
/**
 * The longest one try can run past its due moment: a turn of the background
 * retry before it is taken, the scanner's own reading of its part, and the
 * dashboard's thirty seconds to answer.
 */
const TRY_SLACK_MS = PRIVACY_RETRY_INTERVAL_MS + 30_000 + DATA_COPY_TIMEOUT_MS;
/** A copy mailed this recently answers a second press, instead of a second copy. */
const RECENT_COPY_MS = 10 * 60_000;
/** Longer than a try takes, so a try in progress is never taken over. */
const CLAIM_LEASE_MS = 2 * 60_000;
const RETRY_BATCH_SIZE = 10;
/** How long a request is kept once it was sent or gave up: a fingerprint of its address and its dates. */
export const SETTLED_COPY_RETENTION_MS = 30 * 86_400_000;

/** The most of each list the scanner's part carries; each list says how many there are. */
const SCANNER_COPY_ROWS_MAX = {
  reports: 200,
  analyticsEvents: 1_000,
  registrations: 200,
  requests: 50,
};

type Request = typeof dataCopyRequests.$inferSelect;
type Ended = "sent" | "refused" | "no_answer" | "too_large";

/** What a press is told, from the request as it stands once the press is done. */
export type CopyAnswer =
  | Readonly<{ status: "sent"; sentAt: Date; fresh: boolean }>
  /**
   * Tries remain. `outcome` is how the last one ended, or `in_progress` while
   * one is being made; `lastTryBy` is when the last try will have ended.
   */
  | Readonly<{
      status: "pending";
      outcome: "refused" | "no_answer" | "in_progress";
      lastTryBy: Date;
    }>
  /** Every try ended without the mail provider confirming it took the copy. */
  | Readonly<{ status: "unconfirmed" }>
  /** The copy is larger than the dashboard takes; nothing was mailed. */
  | Readonly<{ status: "too_large" }>
  /** The address's data was deleted while the request was answered, and the request with it. */
  | Readonly<{ status: "deleted" }>;

const iso = (value: Date | null): string | null => (value === null ? null : value.toISOString());

const addressHash = (email: string): string =>
  hmacHex(getServerConfig().hmacSecret, "email", normalizeEmail(email));

/** When the last try of a request still pending will have ended, each try allowed its slack. */
function lastTryBy(request: Request): Date {
  const next = request.nextAttemptAt?.getTime() ?? Date.now();
  const delays = COPY_RETRY_DELAYS_MS.slice(request.attempts).reduce(
    (sum, delay) => sum + delay,
    0,
  );
  const tries = COPY_TRIES - request.attempts;
  return new Date(next + delays + tries * TRY_SLACK_MS);
}

function answerOf(request: Request, pressedAt: Date): CopyAnswer {
  if (request.state === "sent" && request.settledAt !== null)
    return {
      status: "sent",
      sentAt: request.settledAt,
      fresh: request.settledAt.getTime() >= pressedAt.getTime(),
    };
  if (request.state === "failed")
    return { status: request.lastOutcome === "too_large" ? "too_large" : "unconfirmed" };
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

/** What ends a request for good, with its address forgotten. */
const settledAs = (state: "sent" | "failed", now: Date) => ({
  state,
  settledAt: now,
  nextAttemptAt: null,
  leaseToken: null,
  leaseExpiresAt: null,
  emailNormalizedCiphertext: null,
});

/**
 * Takes one due request no other try holds, and counts the try as it takes
 * it, so a process that dies mid-try still spends one. A request whose tries
 * were all spent that way gives up here, unconfirmed. `id` names the one to
 * take.
 */
async function claim(
  id?: string,
): Promise<(Request & { leaseToken: string }) | "spent" | undefined> {
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
    if (due.attempts >= COPY_TRIES) {
      await tx
        .update(dataCopyRequests)
        .set({ ...settledAs("failed", now), lastOutcome: "no_answer" })
        .where(eq(dataCopyRequests.id, due.id));
      return "spent";
    }
    const leaseToken = createUuidV7();
    const attempts = due.attempts + 1;
    await tx
      .update(dataCopyRequests)
      .set({ attempts, leaseToken, leaseExpiresAt: new Date(now.getTime() + CLAIM_LEASE_MS) })
      .where(eq(dataCopyRequests.id, due.id));
    return { ...due, attempts, leaseToken };
  });
}

/** Writes how a try ended, if this try still holds the request. */
async function settleTry(claimed: Request & { leaseToken: string }, ended: Ended): Promise<void> {
  const now = new Date();
  const delay = COPY_RETRY_DELAYS_MS[claimed.attempts - 1];
  const finished = ended === "sent" || ended === "too_large" || delay === undefined;
  await getDatabase()
    .db.update(dataCopyRequests)
    .set({
      lastOutcome: ended === "sent" ? null : ended,
      ...(finished
        ? settledAs(ended === "sent" ? "sent" : "failed", now)
        : {
            leaseToken: null,
            leaseExpiresAt: null,
            nextAttemptAt: new Date(now.getTime() + delay),
          }),
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
export async function runDataCopy(input: { id?: string } = {}): Promise<Ended | "none"> {
  const claimed = await claim(input.id);
  if (claimed === undefined) return "none";
  if (claimed === "spent") return "no_answer";
  let ended: Ended;
  try {
    const config = getServerConfig();
    const email = normalizeEmail(
      decryptSensitiveValue(claimed.emailNormalizedCiphertext ?? "", config.encryptionKey),
    );
    if (addressHash(email) !== claimed.emailLookupHash)
      throw new Error("data_copy_address_mismatch");
    const answered = await getDashboardReportIdentityClient().sendDataCopy({
      request: claimed.id,
      requestedAt: claimed.requestedAt,
      email,
      scanner: await scannerCopyOf(email),
    });
    ended = answered.status === "accepted" ? "sent" : "refused";
  } catch (thrown) {
    // Without an answer the dashboard may have mailed the copy. A later try
    // carries the same request, which the mail provider takes as a repeat.
    ended = thrown instanceof DashboardRequestTooLarge ? "too_large" : "no_answer";
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
  // Deleting the address removes its requests with everything else.
  if (now === undefined) return { status: "deleted" };
  return answerOf(now, pressedAt);
}

/** Forgets the requests sent or given up more than thirty days ago. */
async function forgetSettledCopies(now: Date): Promise<void> {
  await getDatabase()
    .db.delete(dataCopyRequests)
    .where(
      and(
        ne(dataCopyRequests.state, "pending"),
        lt(dataCopyRequests.settledAt, new Date(now.getTime() - SETTLED_COPY_RETENTION_MS)),
      ),
    );
}

let retryRunning = false;

/**
 * The background retry's turn: the requests whose next try is due, a batch at
 * a time, and then the settled requests past their thirty days.
 */
export async function retryDueDataCopies(): Promise<number> {
  if (retryRunning) return 0;
  retryRunning = true;
  let sent = 0;
  try {
    await forgetSettledCopies(new Date());
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
 * The person's reports are the scans their lead is linked to. Browser
 * sessions are left out: the browser that scanned a site and registered for
 * its report can be somebody else's, since anyone can type any address.
 */
async function scannerCopyOf(email: string): Promise<Record<string, unknown>> {
  const { db } = getDatabase();
  const config = getServerConfig();
  const hash = addressHash(email);
  const decrypted = (value: string | null): string | null =>
    value === null ? null : decryptSensitiveValue(value, config.encryptionKey);
  const counted = async (table: typeof registrationIntents | typeof dataCopyRequests) =>
    (await db.select({ total: count() }).from(table).where(eq(table.emailLookupHash, hash)))[0]
      ?.total ?? 0;
  const [lead] = await db
    .select()
    .from(leads)
    .where(and(eq(leads.emailLookupHash, hash), isNull(leads.anonymizedAt)))
    .limit(1);
  const intents = await db
    .select()
    .from(registrationIntents)
    .where(eq(registrationIntents.emailLookupHash, hash))
    .orderBy(desc(registrationIntents.createdAt))
    .limit(SCANNER_COPY_ROWS_MAX.registrations);
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
      "Browser visits and the privacy choices made in them: the browser that scanned a site and registered for its report can be somebody else's, since anyone can type any address.",
      "A phone number typed with this address on a registration that was never confirmed from this address's mailbox, for the same reason.",
      `Beyond the newest ${SCANNER_COPY_ROWS_MAX.reports} reports, ${SCANNER_COPY_ROWS_MAX.registrations} registrations, ${SCANNER_COPY_ROWS_MAX.analyticsEvents.toLocaleString("en-US")} analytics events and ${SCANNER_COPY_ROWS_MAX.requests} copy requests; each list's "total" says how many there are in all.`,
    ],
    registrations: {
      total: await counted(registrationIntents),
      rows: intents.map((intent) => ({
        scan_id: intent.scanId,
        role: intent.role,
        phone: intent.consumedAt === null ? null : decrypted(intent.phoneE164Ciphertext),
        site_ownership_claim: intent.siteOwnershipClaim,
        marketing_email_opt_in: intent.marketingEmailOptIn,
        dataset_reuse_acknowledged: intent.datasetReuseAcknowledged,
        asked_at: iso(intent.createdAt),
        expires_at: iso(intent.expiresAt),
        confirmed_at: iso(intent.consumedAt),
      })),
    },
    data_requests: {
      total: await counted(dataCopyRequests),
      rows: asked.map((one) => ({
        requested_at: iso(one.requestedAt),
        state: one.state,
        settled_at: iso(one.settledAt),
      })),
    },
  };
  if (lead === undefined) return { ...base, lead: null };
  // The reports of an address whose deletion was asked for are already closed
  // and are being erased; they are not copied, and the copy says why.
  if (lead.deletionRequestedAt !== null)
    return {
      ...base,
      lead: {
        email: normalizeEmail(email),
        deletion_requested_at: iso(lead.deletionRequestedAt),
        held: "Being deleted: the reports, registrations and events filed under this address are not copied.",
      },
    };

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
    analytics_events: {
      total: eventTotal,
      rows: events.map((event) => ({
        name: event.name,
        occurred_at: iso(event.occurredAt),
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
