/**
 * A request for the full report of one scan, from asking to finished.
 *
 * A stranger's request waits for its own link: the scanner writes it down, asks
 * the cabinet to send a link for the address to the report of this scan, and
 * names the request, which the cabinet records with the token and then with
 * the session the link opens. The scanner finishes it at that session's first
 * visit, whichever page it is (ADR-0026 §2). A signed-in person's own ask is
 * made and finished at once, under the session's address, with no message.
 * Finishing is what links the lead to the scan, and it is the only way a
 * report comes to belong to an address.
 */

import { partnerClickIdSchema, type RegistrationRequest } from "@agentify/scanner-contracts";
import type { SendReportLinkResponse } from "@agentify/scanner-contracts/report-identity";
import {
  consentSnapshots,
  createUuidV7,
  type DatabaseTransaction,
  deliveryOutbox,
  emitStoredBusinessEvent,
  leadScans,
  leads,
  registrationIntents,
  scans,
  sessions,
  waitlistEntries,
} from "@agentify/scanner-database";
import { and, eq, gt, isNull, sql } from "drizzle-orm";
import { getCabinetReportIdentityClient } from "./cabinet-report-identity";
import { getServerConfig } from "./config";
import {
  decryptSensitiveValue,
  encryptEmail,
  encryptSensitiveValue,
  hmacHex,
  normalizeEmail,
} from "./crypto";
import { getDatabase } from "./database";
import type { LinkSendOutcome } from "./link-wait";
import { consumeRateLimitsAtomically, refundRateLimitEvent } from "./rate-limit";

const REGISTRATION_INTENT_TTL_MS = 60 * 60 * 1000;

type RegistrationIntentOptions = Readonly<{
  partnerClickId?: string;
  sendReportLink?: (email: string, request: string) => Promise<SendReportLinkResponse>;
}>;

/** What a request is made of, written down before anything is sent or finished. */
function intentValues(
  scan: typeof scans.$inferSelect,
  body: RegistrationRequest,
  normalizedEmail: string,
  partnerClickId: string | undefined,
  now: Date,
) {
  const config = getServerConfig();
  return {
    id: createUuidV7(),
    scanId: scan.id,
    sessionId: scan.sessionId,
    emailNormalizedCiphertext: encryptEmail(normalizedEmail, config.encryptionKey),
    emailLookupHash: hmacHex(config.hmacSecret, "email", normalizedEmail),
    phoneE164Ciphertext: body.phone ? encryptEmail(body.phone, config.encryptionKey) : null,
    phoneLookupHash: body.phone ? hmacHex(config.hmacSecret, "phone", body.phone) : null,
    partnerClickIdCiphertext: partnerClickId
      ? encryptSensitiveValue(partnerClickId, config.encryptionKey)
      : null,
    role: body.role,
    siteOwnershipClaim: body.site_is_mine,
    marketingEmailOptIn: body.marketing_email_opt_in,
    datasetReuseAcknowledged: body.dataset_reuse_acknowledged,
    expiresAt: new Date(now.getTime() + REGISTRATION_INTENT_TTL_MS),
  };
}

async function refuseDeletingAddress(tx: DatabaseTransaction, emailLookupHash: string) {
  const deleting = (
    await tx
      .select({ id: leads.id })
      .from(leads)
      .where(
        and(
          eq(leads.emailLookupHash, emailLookupHash),
          sql`${leads.deletionRequestedAt} is not null`,
          isNull(leads.anonymizedAt),
        ),
      )
      .limit(1)
  )[0];
  if (deleting) throw new Error("registration_email_deleting");
}

/**
 * A stranger's request: written down, then a link asked of the cabinet.
 *
 * The request is inactive until the cabinet says the link went out, so a
 * request whose message never left cannot be finished by anybody.
 */
export async function createScannerRegistrationIntent(
  scan: typeof scans.$inferSelect,
  body: RegistrationRequest & { email: string },
  options: RegistrationIntentOptions = {},
): Promise<LinkSendOutcome> {
  const config = getServerConfig();
  const partnerClickId = partnerClickIdSchema.safeParse(options.partnerClickId);
  const normalizedEmail = normalizeEmail(body.email);
  const emailLookupHash = hmacHex(config.hmacSecret, "email", normalizedEmail);
  const limits = await consumeRateLimitsAtomically([
    {
      keyHash: hmacHex(config.hmacSecret, "registration-email", emailLookupHash),
      kind: "registration_email_hour",
      limit: 3,
    },
    {
      keyHash: hmacHex(config.hmacSecret, "registration-session", scan.sessionId),
      kind: "registration_session_hour",
      limit: 10,
    },
  ]);
  if (!limits.allowed)
    return {
      sent: false as const,
      retryAt: limits.retryAt,
      wall:
        limits.wall === "registration_email_hour"
          ? ("address_hour" as const)
          : ("unspecified" as const),
    };

  const now = new Date();
  const { db } = getDatabase();
  const intent = intentValues(
    scan,
    body,
    normalizedEmail,
    partnerClickId.success ? partnerClickId.data : undefined,
    now,
  );
  await db.transaction(async (tx) => {
    await lockScannerEmail(tx, emailLookupHash);
    await refuseDeletingAddress(tx, emailLookupHash);
    if (!(await currentRegistrationScan(tx, scan)))
      throw new Error("registration_scan_unavailable");
    await tx.insert(registrationIntents).values({ ...intent, consumedAt: now });
  });

  let handover: SendReportLinkResponse;
  try {
    handover = options.sendReportLink
      ? await options.sendReportLink(normalizedEmail, intent.id)
      : await getCabinetReportIdentityClient().sendReportLink({
          email: normalizedEmail,
          scanId: scan.id,
          request: intent.id,
        });
  } catch {
    throw new Error("cabinet_identity_unavailable");
  }
  // The cabinet's walls are the ones that know when they fall; `retry_at` is
  // that moment, and it reaches the caller instead of being thrown away. No
  // letter went out, so the address gets its link back — see the refund in
  // `rate-limit.ts` for why the session's hour does not.
  if (handover.status === "cooldown") {
    const letter = limits.spent.find(({ kind }) => kind === "registration_email_hour");
    if (letter) await refundRateLimitEvent(letter.eventId);
    return {
      sent: false as const,
      retryAt: new Date(handover.retry_at),
      wall: "unspecified" as const,
    };
  }
  if (handover.status !== "accepted") throw new Error("cabinet_identity_unavailable");
  await db.transaction(async (tx) => {
    await lockScannerEmail(tx, emailLookupHash);
    if (!(await currentRegistrationScan(tx, scan)))
      throw new Error("registration_scan_unavailable");
    const activated = await tx
      .update(registrationIntents)
      .set({ consumedAt: null })
      .where(eq(registrationIntents.id, intent.id))
      .returning({ id: registrationIntents.id });
    if (!activated.length) throw new Error("registration_scan_unavailable");
  });
  return { sent: true as const };
}

/**
 * A signed-in person's own ask: made and finished at once, with no message.
 *
 * The address is the session's and never the form's, and the request is a new
 * one carrying this person's own choices. A request somebody else made with
 * this address is left waiting until it expires, because it carries what its
 * form said, a marketing choice included (ADR-0026 §2).
 */
export async function askAsSignedIn(
  scan: typeof scans.$inferSelect,
  body: RegistrationRequest,
  sessionEmail: string,
  options: Pick<RegistrationIntentOptions, "partnerClickId"> = {},
): Promise<LinkSendOutcome> {
  const config = getServerConfig();
  const partnerClickId = partnerClickIdSchema.safeParse(options.partnerClickId);
  const normalizedEmail = normalizeEmail(sessionEmail);
  const emailLookupHash = hmacHex(config.hmacSecret, "email", normalizedEmail);
  // No message goes out, so the address's hour is not spent; the scan's hour
  // still counts asks, which is what keeps one session from filing a report
  // under its address over and over.
  const limits = await consumeRateLimitsAtomically([
    {
      keyHash: hmacHex(config.hmacSecret, "registration-session", scan.sessionId),
      kind: "registration_session_hour",
      limit: 10,
    },
  ]);
  if (!limits.allowed)
    return { sent: false as const, retryAt: limits.retryAt, wall: "unspecified" as const };
  const now = new Date();
  const intent = intentValues(
    scan,
    { ...body, email: normalizedEmail },
    normalizedEmail,
    partnerClickId.success ? partnerClickId.data : undefined,
    now,
  );
  await getDatabase().db.transaction(async (tx) => {
    await lockScannerEmail(tx, emailLookupHash);
    await refuseDeletingAddress(tx, emailLookupHash);
    if (!(await currentRegistrationScan(tx, scan)))
      throw new Error("registration_scan_unavailable");
    await tx.insert(registrationIntents).values({ ...intent, consumedAt: null });
    const finished = await finishIntentInTransaction(tx, intent.id, normalizedEmail);
    if (!finished) throw new Error("registration_scan_unavailable");
  });
  return { sent: true as const };
}

/**
 * Finishes the request a session names, at that session's first visit.
 *
 * Idempotent across tabs: every page a session opens may be the first, the
 * address's lock puts them in a line, and only the first finds the request
 * still waiting. A request for another address, one already finished, and one
 * that has waited past its hour are left as they are. A scan that can no
 * longer carry a report finishes nothing and is not an error of the visit.
 */
export async function finishWaitingRequest(requestId: string, email: string): Promise<boolean> {
  return await getDatabase().db.transaction(async (tx) => {
    const normalizedEmail = normalizeEmail(email);
    await lockScannerEmail(tx, hmacHex(getServerConfig().hmacSecret, "email", normalizedEmail));
    return (await finishIntentInTransaction(tx, requestId, normalizedEmail)) !== undefined;
  });
}

type FinishedRegistration = Readonly<{ leadId: string; scanId: string }>;

async function lockScannerEmail(tx: DatabaseTransaction, emailLookupHash: string) {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${emailLookupHash}, 0))`);
}

async function currentRegistrationScan(
  tx: DatabaseTransaction,
  snapshot: typeof scans.$inferSelect,
) {
  const current = (
    await tx
      .select({
        sessionId: scans.sessionId,
        status: scans.status,
        accessTokenHash: scans.accessTokenHash,
      })
      .from(scans)
      .where(eq(scans.id, snapshot.id))
      .limit(1)
      .for("update")
  )[0];
  return (
    current?.sessionId === snapshot.sessionId &&
    (current.status === "completed" || current.status === "partial") &&
    current.accessTokenHash === snapshot.accessTokenHash
  );
}

/**
 * The finishing itself, inside a transaction that already holds the address's
 * lock: the lead, its link to the scan, the consent the form gave, the record
 * that this lead registered for this scan, and the event.
 */
async function finishIntentInTransaction(
  tx: DatabaseTransaction,
  requestId: string,
  normalizedEmail: string,
): Promise<FinishedRegistration | undefined> {
  const config = getServerConfig();
  const emailLookupHash = hmacHex(config.hmacSecret, "email", normalizedEmail);
  const now = new Date();

  const waiting = (
    await tx
      .select()
      .from(registrationIntents)
      .where(
        and(
          eq(registrationIntents.id, requestId),
          eq(registrationIntents.emailLookupHash, emailLookupHash),
          isNull(registrationIntents.consumedAt),
          gt(registrationIntents.expiresAt, now),
        ),
      )
      .limit(1)
      .for("update")
  )[0];
  if (!waiting) return undefined;

  const scan = (
    await tx.select().from(scans).where(eq(scans.id, waiting.scanId)).limit(1).for("update")
  )[0];
  if (
    !scan ||
    scan.sessionId !== waiting.sessionId ||
    (scan.status !== "completed" && scan.status !== "partial")
  ) {
    return undefined;
  }
  const intent = (
    await tx
      .update(registrationIntents)
      .set({ consumedAt: now })
      .where(eq(registrationIntents.id, waiting.id))
      .returning()
  )[0];
  if (!intent) return undefined;

  let lead = (
    await tx.select().from(leads).where(eq(leads.emailLookupHash, emailLookupHash)).limit(1)
  )[0];
  // The phone is optional on the form: one given now replaces the stored
  // one, and none given leaves a stored one alone.
  const phoneUpdate =
    intent.phoneE164Ciphertext && intent.phoneLookupHash
      ? {
          phoneE164Ciphertext: intent.phoneE164Ciphertext,
          phoneLookupHash: intent.phoneLookupHash,
        }
      : {};
  let firstVerification: boolean;
  if (!lead) {
    const leadId = createUuidV7();
    await tx.insert(leads).values({
      id: leadId,
      emailNormalizedCiphertext: intent.emailNormalizedCiphertext,
      emailLookupHash,
      phoneE164Ciphertext: intent.phoneE164Ciphertext,
      phoneLookupHash: intent.phoneLookupHash,
      role: intent.role,
      verifiedAt: now,
      firstSegment: scan.segment,
      firstSessionId: intent.sessionId,
    });
    lead = (await tx.select().from(leads).where(eq(leads.id, leadId)).limit(1))[0];
    firstVerification = true;
  } else {
    const newlyVerified = (
      await tx
        .update(leads)
        .set({
          emailNormalizedCiphertext: intent.emailNormalizedCiphertext,
          ...phoneUpdate,
          role: intent.role,
          verifiedAt: now,
        })
        .where(and(eq(leads.id, lead.id), isNull(leads.verifiedAt)))
        .returning({ id: leads.id })
    )[0];
    firstVerification = Boolean(newlyVerified);
    await tx
      .update(leads)
      .set({
        emailNormalizedCiphertext: intent.emailNormalizedCiphertext,
        ...phoneUpdate,
        role: intent.role,
      })
      .where(eq(leads.id, lead.id));
  }
  if (!lead) throw new Error("lead_creation_failed");

  await tx
    .insert(leadScans)
    .values({
      leadId: lead.id,
      scanId: scan.id,
      siteOwnershipClaim: intent.siteOwnershipClaim,
    })
    .onConflictDoUpdate({
      target: [leadScans.leadId, leadScans.scanId],
      set: { siteOwnershipClaim: intent.siteOwnershipClaim },
    });
  await tx.update(scans).set({ leadId: lead.id }).where(eq(scans.id, scan.id));

  const registrationSession = (
    await tx.select().from(sessions).where(eq(sessions.id, intent.sessionId)).limit(1)
  )[0];
  const previousConsent = registrationSession?.consentSnapshotId
    ? (
        await tx
          .select()
          .from(consentSnapshots)
          .where(eq(consentSnapshots.id, registrationSession.consentSnapshotId))
          .limit(1)
      )[0]
    : undefined;
  const consentId = createUuidV7();
  await tx.insert(consentSnapshots).values({
    id: consentId,
    sessionId: intent.sessionId,
    policyVersion: "phase-a-v2",
    country: previousConsent?.country,
    categories: {
      ...(typeof previousConsent?.categories === "object" ? previousConsent.categories : {}),
      essential_processing: true,
      dataset_reuse: true,
      marketing_email: intent.marketingEmailOptIn,
    },
    source: "report_identity_registration",
  });
  await tx
    .update(sessions)
    .set({ consentSnapshotId: consentId })
    .where(eq(sessions.id, intent.sessionId));

  await tx
    .insert(waitlistEntries)
    .values({ id: createUuidV7(), leadId: lead.id, scanId: scan.id })
    .onConflictDoNothing({
      target: [waitlistEntries.leadId, waitlistEntries.scanId],
    });
  const registrationEvent = await emitStoredBusinessEvent(tx, {
    name: "registration_completed",
    identifiers: { lead_id: lead.id, scan_id: scan.id },
    sessionId: intent.sessionId,
    consentSnapshotId: consentId,
    leadId: lead.id,
    scanId: scan.id,
    segment: scan.segment,
    landingVariant: registrationSession?.firstLandingVariant ?? "unknown",
    properties: {
      role: intent.role,
      auth_provider: "cabinet_report_identity",
    },
  });
  const previousCategories =
    typeof previousConsent?.categories === "object" && previousConsent.categories !== null
      ? (previousConsent.categories as Record<string, unknown>)
      : {};
  if (
    config.PARTNER_POSTBACK_ENABLED &&
    firstVerification &&
    previousCategories.ads_measurement === true &&
    intent.partnerClickIdCiphertext
  ) {
    const partnerClickId = partnerClickIdSchema.parse(
      decryptSensitiveValue(intent.partnerClickIdCiphertext, config.encryptionKey),
    );
    await tx
      .insert(deliveryOutbox)
      .values({
        id: createUuidV7(),
        eventId: registrationEvent.eventId,
        destination: "partner_tracker",
        payload: { clickid: partnerClickId, event: "reg" },
      })
      .onConflictDoNothing({
        target: [deliveryOutbox.eventId, deliveryOutbox.destination],
      });
  }

  return { leadId: lead.id, scanId: scan.id };
}
