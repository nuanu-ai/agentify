import {
  partnerClickIdSchema,
  type RegistrationRequest,
} from "@agentify/scanner-contracts";
import {
  consentSnapshots,
  createUuidV7,
  deliveryOutbox,
  emitStoredBusinessEvent,
  leads,
  leadScans,
  registrationIntents,
  reportSessions,
  scans,
  scannerAuthUsers,
  sessions,
  waitlistEntries,
  type DatabaseTransaction,
} from "@agentify/scanner-database";
import { and, eq, gt, isNull, sql } from "drizzle-orm";

import { getServerConfig } from "./config";
import {
  decryptSensitiveValue,
  encryptEmail,
  encryptSensitiveValue,
  hmacHex,
  normalizeEmail,
  randomCapability,
  sha256,
} from "./crypto";
import { getDatabase } from "./database";
import { consumeRateLimitsAtomically } from "./rate-limit";
import {
  consumeScannerMagicLinkInTransaction,
  inspectScannerMagicLink,
  sendScannerMagicLink,
} from "./scanner-auth";

const REGISTRATION_INTENT_TTL_MS = 60 * 60 * 1000;

type RegistrationIntentOptions = Readonly<{
  partnerClickId?: string;
  sendMagicLink?: (email: string, redirectTo: string) => Promise<void>;
}>;

export async function createScannerRegistrationIntent(
  scan: typeof scans.$inferSelect,
  body: RegistrationRequest,
  options: RegistrationIntentOptions = {},
) {
  const config = getServerConfig();
  const partnerClickId = partnerClickIdSchema.safeParse(options.partnerClickId);
  const normalizedEmail = normalizeEmail(body.email);
  const emailLookupHash = hmacHex(config.hmacSecret, "email", normalizedEmail);
  const limits = await consumeRateLimitsAtomically([
    {
      keyHash: hmacHex(
        config.hmacSecret,
        "registration-email",
        emailLookupHash,
      ),
      kind: "registration_email_hour",
      limit: 3,
    },
    {
      keyHash: hmacHex(
        config.hmacSecret,
        "registration-session",
        scan.sessionId,
      ),
      kind: "registration_session_hour",
      limit: 10,
    },
  ]);
  if (!limits.allowed) return { sent: false as const };

  const state = randomCapability();
  const now = new Date();
  const { db } = getDatabase();
  const intentId = createUuidV7();
  await db.transaction(async (tx) => {
    await lockScannerEmail(tx, emailLookupHash);
    if (!(await currentRegistrationScan(tx, scan)))
      throw new Error("registration_scan_unavailable");
    await tx.insert(registrationIntents).values({
      id: intentId,
      scanId: scan.id,
      sessionId: scan.sessionId,
      callbackStateHash: sha256(state),
      emailNormalizedCiphertext: encryptEmail(
        normalizedEmail,
        config.encryptionKey,
      ),
      emailLookupHash,
      phoneE164Ciphertext: encryptEmail(body.phone, config.encryptionKey),
      phoneLookupHash: hmacHex(config.hmacSecret, "phone", body.phone),
      partnerClickIdCiphertext: partnerClickId.success
        ? encryptSensitiveValue(partnerClickId.data, config.encryptionKey)
        : null,
      role: body.role,
      siteOwnershipClaim: body.site_is_mine,
      marketingEmailOptIn: body.marketing_email_opt_in,
      datasetReuseAcknowledged: body.dataset_reuse_acknowledged,
      consumedAt: now,
      expiresAt: new Date(now.getTime() + REGISTRATION_INTENT_TTL_MS),
    });
  });

  const redirectTo = new URL("/auth/callback", config.appBaseUrl);
  redirectTo.searchParams.set("state", state);
  try {
    if (options.sendMagicLink) {
      await options.sendMagicLink(normalizedEmail, redirectTo.toString());
    } else {
      await sendScannerMagicLink(normalizedEmail, state);
    }
  } catch {
    throw new Error("scanner_auth_email_unavailable");
  }
  await db.transaction(async (tx) => {
    await lockScannerEmail(tx, emailLookupHash);
    if (!(await currentRegistrationScan(tx, scan)))
      throw new Error("registration_scan_unavailable");
    await tx
      .update(registrationIntents)
      .set({ consumedAt: new Date() })
      .where(
        and(
          eq(registrationIntents.scanId, scan.id),
          eq(registrationIntents.emailLookupHash, emailLookupHash),
          isNull(registrationIntents.consumedAt),
        ),
      );
    const activated = await tx
      .update(registrationIntents)
      .set({ consumedAt: null })
      .where(eq(registrationIntents.id, intentId))
      .returning({ id: registrationIntents.id });
    if (!activated.length) throw new Error("registration_scan_unavailable");
  });
  return { sent: true as const };
}

type FinalizedRegistration = Readonly<{
  scanId: string;
  sessionToken: string;
}>;

type VerifiedScannerUser = Readonly<{ id: string; email: string }>;

async function lockScannerEmail(
  tx: DatabaseTransaction,
  emailLookupHash: string,
) {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${emailLookupHash}, 0))`,
  );
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

export async function finalizeScannerRegistration(
  state: string,
  user: VerifiedScannerUser,
): Promise<FinalizedRegistration | undefined> {
  return await getDatabase().db.transaction((tx) =>
    finalizeScannerRegistrationInTransaction(tx, state, user),
  );
}

async function finalizeScannerRegistrationInTransaction(
  tx: DatabaseTransaction,
  state: string,
  user: VerifiedScannerUser,
): Promise<FinalizedRegistration | undefined> {
  if (!user?.email) return undefined;
  const account = (
    await tx
      .select({
        email: scannerAuthUsers.email,
        confirmed: scannerAuthUsers.emailVerified,
      })
      .from(scannerAuthUsers)
      .where(eq(scannerAuthUsers.id, user.id))
      .limit(1)
  )[0];
  if (
    !account?.confirmed ||
    normalizeEmail(account.email) !== normalizeEmail(user.email)
  ) {
    return undefined;
  }

  const config = getServerConfig();
  const emailLookupHash = hmacHex(
    config.hmacSecret,
    "email",
    normalizeEmail(user.email),
  );
  const sessionToken = randomCapability();
  const now = new Date();

  const intent = (
    await tx
      .update(registrationIntents)
      .set({ consumedAt: now })
      .where(
        and(
          eq(registrationIntents.callbackStateHash, sha256(state)),
          eq(registrationIntents.emailLookupHash, emailLookupHash),
          gt(registrationIntents.expiresAt, now),
          isNull(registrationIntents.consumedAt),
        ),
      )
      .returning()
  )[0];
  if (!intent) return undefined;

  const scan = (
    await tx
      .select()
      .from(scans)
      .where(eq(scans.id, intent.scanId))
      .limit(1)
      .for("update")
  )[0];
  if (
    !scan ||
    scan.sessionId !== intent.sessionId ||
    (scan.status !== "completed" && scan.status !== "partial")
  ) {
    throw new Error("registration_scan_unavailable");
  }

  let lead = (
    await tx
      .select()
      .from(leads)
      .where(eq(leads.emailLookupHash, emailLookupHash))
      .limit(1)
  )[0];
  if (lead?.scannerAuthUserId && lead.scannerAuthUserId !== user.id) {
    throw new Error("scanner_identity_conflict");
  }
  let firstVerification: boolean;
  if (!lead) {
    const leadId = createUuidV7();
    await tx.insert(leads).values({
      id: leadId,
      scannerAuthUserId: user.id,
      emailNormalizedCiphertext: intent.emailNormalizedCiphertext,
      emailLookupHash,
      phoneE164Ciphertext: intent.phoneE164Ciphertext,
      phoneLookupHash: intent.phoneLookupHash,
      role: intent.role,
      verifiedAt: now,
      firstSegment: scan.segment,
      firstSessionId: intent.sessionId,
    });
    lead = (
      await tx.select().from(leads).where(eq(leads.id, leadId)).limit(1)
    )[0];
    firstVerification = true;
  } else {
    const newlyVerified = (
      await tx
        .update(leads)
        .set({
          scannerAuthUserId: user.id,
          emailNormalizedCiphertext: intent.emailNormalizedCiphertext,
          phoneE164Ciphertext: intent.phoneE164Ciphertext,
          phoneLookupHash: intent.phoneLookupHash,
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
        scannerAuthUserId: user.id,
        emailNormalizedCiphertext: intent.emailNormalizedCiphertext,
        phoneE164Ciphertext: intent.phoneE164Ciphertext,
        phoneLookupHash: intent.phoneLookupHash,
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
    await tx
      .select()
      .from(sessions)
      .where(eq(sessions.id, intent.sessionId))
      .limit(1)
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
      ...(typeof previousConsent?.categories === "object"
        ? previousConsent.categories
        : {}),
      essential_processing: true,
      dataset_reuse: true,
      marketing_email: intent.marketingEmailOptIn,
    },
    source: "scanner_auth_registration",
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
  await tx.insert(reportSessions).values({
    id: createUuidV7(),
    leadId: lead.id,
    sessionTokenHash: sha256(sessionToken),
    expiresAt: new Date(now.getTime() + 30 * 86_400_000),
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
    properties: { role: intent.role, auth_provider: "better_auth" },
  });
  const previousCategories =
    typeof previousConsent?.categories === "object" &&
    previousConsent.categories !== null
      ? (previousConsent.categories as Record<string, unknown>)
      : {};
  if (
    config.PARTNER_POSTBACK_ENABLED &&
    firstVerification &&
    previousCategories.ads_measurement === true &&
    intent.partnerClickIdCiphertext
  ) {
    const partnerClickId = partnerClickIdSchema.parse(
      decryptSensitiveValue(
        intent.partnerClickIdCiphertext,
        config.encryptionKey,
      ),
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

  return { scanId: scan.id, sessionToken };
}

export async function verifyAndFinalizeScannerRegistration(
  state: string,
  token: string,
) {
  const config = getServerConfig();
  return await getDatabase().db.transaction(async (tx) => {
    const email = await inspectScannerMagicLink(token, tx);
    if (!email) return undefined;
    const emailLookupHash = hmacHex(
      config.hmacSecret,
      "email",
      normalizeEmail(email),
    );
    await lockScannerEmail(tx, emailLookupHash);
    const intent = (
      await tx
        .select({
          scanId: registrationIntents.scanId,
          sessionId: registrationIntents.sessionId,
        })
        .from(registrationIntents)
        .where(
          and(
            eq(registrationIntents.callbackStateHash, sha256(state)),
            eq(registrationIntents.emailLookupHash, emailLookupHash),
            gt(registrationIntents.expiresAt, new Date()),
            isNull(registrationIntents.consumedAt),
          ),
        )
        .limit(1)
    )[0];
    if (!intent || !(await inspectScannerMagicLink(token, tx)))
      return undefined;
    const scan = (
      await tx
        .select({ status: scans.status, sessionId: scans.sessionId })
        .from(scans)
        .where(eq(scans.id, intent.scanId))
        .limit(1)
        .for("update")
    )[0];
    if (
      !scan ||
      scan.sessionId !== intent.sessionId ||
      (scan.status !== "completed" && scan.status !== "partial")
    )
      return undefined;
    const verified = await consumeScannerMagicLinkInTransaction(tx, token);
    if (
      hmacHex(config.hmacSecret, "email", normalizeEmail(verified.email)) !==
      emailLookupHash
    )
      throw new Error("verification_email_mismatch");
    const finalized = await finalizeScannerRegistrationInTransaction(
      tx,
      state,
      verified,
    );
    // An unavailable lead or report must roll back the token and BA identity.
    if (!finalized) throw new Error("registration_finalization_failed");
    return finalized;
  });
}
