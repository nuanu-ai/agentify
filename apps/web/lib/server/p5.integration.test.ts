import { fileURLToPath } from "node:url";

import {
  analyticsEvents,
  consentSnapshots,
  createDatabase,
  createUuidV7,
  deliveryOutbox,
  leads,
  leadScans,
  migrateDatabase,
  paymentSignals,
  rateLimitEvents,
  rateWindows,
  registrationIntents,
  reportSessions,
  runRetentionCleanup,
  scannerAuthUsers,
  scannerAuthVerifications,
  scanShares,
  scans,
  sessions,
  verificationTokens,
  waitlistEntries,
  webhookReceipts,
} from "@agentify/scanner-database";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { encryptEmail, hmacHex, sha256 } from "./crypto";
import { getServerConfig } from "./config";
import { getDatabase } from "./database";
import { completeLeadDeletion, executeRetentionCleanup } from "./privacy";
import { localWebhookSignature } from "./stripe-card-signal-crypto";
import { LocalStripeCardSignalProvider } from "./stripe-card-signal-provider";
import {
  detachCardSignal,
  getOwnedCardSignalForReport,
  processCardSignalWebhook,
  setupCardSignal,
} from "./stripe-card-signal";

const connectionString = process.env.MIGRATION_TEST_DATABASE_URL;
if (!connectionString?.includes("_migration_test")) {
  throw new Error(
    "P5 integration requires a dedicated *_migration_test database",
  );
}
process.env.DATABASE_URL = connectionString;
process.env.APP_BASE_URL = "http://localhost:3000";
process.env.TOKEN_HMAC_SECRET =
  "p5-integration-hmac-secret-with-at-least-32-bytes";
process.env.EMAIL_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
process.env.EMAIL_PROVIDER = "local";
process.env.REGISTRATION_ENABLED = "false";
process.env.CARD_SIGNAL_ENABLED = "true";
process.env.STRIPE_ADAPTER = "local";
process.env.STRIPE_WEBHOOK_SECRET = "p5-local-webhook-secret";
process.env.ANALYTICS_RUNTIME_ENV = "test";
process.env.ANALYTICS_SERVER_DELIVERY_ENABLED = "true";
process.env.POSTHOG_API_KEY = "p5-posthog-test-key";
process.env.POSTHOG_DESTINATION_ENV = "test";
process.env.META_CAPI_ENABLED = "false";

const admin = createDatabase(connectionString, { max: 1 });
const migrationsFolder = fileURLToPath(
  new URL("../../../../packages/scanner-database/migrations", import.meta.url),
);
const provider = new LocalStripeCardSignalProvider(
  process.env.STRIPE_WEBHOOK_SECRET,
);
const sessionToken = "p5-report-session-token";
const supabaseUserId = "550e8400-e29b-41d4-a716-446655440000";
const scannerAuthUserId = "scanner-p5-test-user";
let leadId = "";
let scanId = "";
let originalSessionId = "";

beforeAll(async () => {
  await admin.pool.query(
    "drop schema if exists public cascade; drop schema if exists drizzle cascade; create schema public",
  );
  await migrateDatabase(admin.db, migrationsFolder);
  const { db } = getDatabase();
  const config = getServerConfig();
  const sessionId = createUuidV7();
  originalSessionId = sessionId;
  const initialConsentId = createUuidV7();
  leadId = createUuidV7();
  scanId = createUuidV7();
  await db.insert(sessions).values({
    id: sessionId,
    anonymousIdHash: "p5-anonymous-hash",
    firstLandingVariant: "store-v1",
  });
  await db.insert(consentSnapshots).values({
    id: initialConsentId,
    sessionId,
    policyVersion: "consent-v1.0.0",
    categories: {
      essential_processing: true,
      product_analytics: true,
      ads_measurement: false,
      marketing_email: false,
      dataset_reuse: true,
      card_signal: false,
    },
    source: "test",
  });
  await db
    .update(sessions)
    .set({ consentSnapshotId: initialConsentId })
    .where(eq(sessions.id, sessionId));
  await db.insert(scannerAuthUsers).values({
    id: scannerAuthUserId,
    email: "p5-scanner@example.com",
    emailVerified: true,
    name: "",
  });
  await db.insert(leads).values({
    id: leadId,
    supabaseUserId,
    scannerAuthUserId,
    emailNormalizedCiphertext: encryptEmail(
      "p5-scanner@example.com",
      config.encryptionKey,
    ),
    emailLookupHash: hmacHex(
      config.hmacSecret,
      "email",
      "p5-scanner@example.com",
    ),
    role: "business_owner",
    verifiedAt: new Date(),
    firstSegment: "store",
    firstSessionId: sessionId,
  });
  await db.insert(scans).values({
    id: scanId,
    sessionId,
    leadId,
    segment: "store",
    rubricVersion: "gtm-v1.0.0",
    submittedUrlRedacted: "https://example.com/",
    canonicalTargetUrl: "https://example.com/",
    targetHost: "example.com",
    targetHash: "p5-target-hash",
    status: "completed",
    score: 70,
    coverage: "1.000",
    level: "callable_ready",
    applicableWeight: "100",
    earnedWeight: "70",
    finishedAt: new Date(),
    accessTokenHash: "p5-access-token-hash",
    accessTokenExpiresAt: new Date(Date.now() + 86_400_000),
    idempotencyKeyHash: "p5-idem-key",
    idempotencyBodyHash: "p5-idem-body",
  });
  await db.insert(leadScans).values({ leadId, scanId });
  await db.insert(reportSessions).values({
    id: createUuidV7(),
    leadId,
    sessionTokenHash: sha256(sessionToken),
    expiresAt: new Date(Date.now() + 86_400_000),
  });
  await db.insert(waitlistEntries).values({
    id: createUuidV7(),
    leadId,
    scanId,
    painAnswer: "This contains private free-form context.",
    answeredAt: new Date(),
  });
  await db.insert(scanShares).values({
    id: createUuidV7(),
    scanId,
    shareSlugHash: "p5-share-hash",
    publicSnapshot: {
      host: "example.com",
      score: 70,
      level: "callable_ready",
      rubric_version: "gtm-v1.0.0",
      generated_at: new Date().toISOString(),
    },
  });
}, 30_000);

afterAll(async () => {
  await getDatabase().pool.end();
  await admin.pool.query(
    "drop schema if exists public cascade; drop schema if exists drizzle cascade; create schema public",
  );
  await admin.pool.end();
});

describe("P5 card signal flow", () => {
  it("attaches once, hydrates current state, then provider-cleans and anonymizes deletion", async () => {
    const setup = await setupCardSignal({
      sessionToken,
      scanId,
      idempotencyKey: "p5-browser-idempotency-key",
      provider,
    });
    expect(setup).toMatchObject({
      status: "setup_pending",
      adapter: "local",
      clientSecret: expect.any(String),
    });
    if (!("signalId" in setup)) throw new Error("setup_failed");
    await expect(
      getOwnedCardSignalForReport(scanId, sessionToken),
    ).resolves.toMatchObject({
      signalId: setup.signalId,
      status: "setup_pending",
      clientSecret: expect.any(String),
    });
    const signal = (
      await getDatabase()
        .db.select()
        .from(paymentSignals)
        .where(eq(paymentSignals.id, setup.signalId))
    )[0]!;
    const delivery = await provider.confirmLocalSetup(signal.setupIntentId);
    const concurrent = await Promise.all([
      processCardSignalWebhook({ ...delivery, provider }),
      processCardSignalWebhook({ ...delivery, provider }),
    ]);
    expect(concurrent.map((result) => result.status).sort()).toEqual([
      "duplicate",
      "processed",
    ]);

    const stored = (
      await getDatabase()
        .db.select()
        .from(paymentSignals)
        .where(eq(paymentSignals.id, signal.id))
    )[0]!;
    expect(stored.status).toBe("attached");
    expect(stored.paymentMethodIdCiphertext).toMatch(/^v1\./);
    expect(stored.paymentMethodIdCiphertext).not.toContain("pm_local");
    await expect(
      getOwnedCardSignalForReport(scanId, sessionToken),
    ).resolves.toMatchObject({
      signalId: signal.id,
      status: "attached",
      clientSecret: null,
    });
    expect(
      (
        await getDatabase()
          .db.select({ count: sql<number>`count(*)::int` })
          .from(analyticsEvents)
          .where(eq(analyticsEvents.name, "card_attached"))
      )[0]?.count,
    ).toBe(1);
    expect(
      (
        await getDatabase()
          .db.select({ count: sql<number>`count(*)::int` })
          .from(deliveryOutbox)
      )[0]?.count,
    ).toBe(1);
    expect(
      (
        await getDatabase()
          .db.select({ count: sql<number>`count(*)::int` })
          .from(webhookReceipts)
      )[0]?.count,
    ).toBe(1);

    const replayBody = delivery.rawBody.replace(
      '"data":',
      '"unexpected":"changed","data":',
    );
    await expect(
      processCardSignalWebhook({
        rawBody: replayBody,
        signature: localWebhookSignature(
          replayBody,
          process.env.STRIPE_WEBHOOK_SECRET!,
        ),
        provider,
      }),
    ).rejects.toThrow("stripe_event_replay_mismatch");

    await expect(
      detachCardSignal({ signalId: signal.id, sessionToken, provider }),
    ).resolves.toEqual({ status: "detached" });
    await expect(
      getOwnedCardSignalForReport(scanId, sessionToken),
    ).resolves.toMatchObject({
      signalId: signal.id,
      status: "detached",
      clientSecret: null,
    });

    const setupReadback = await provider.retrieveSetup(signal.setupIntentId);
    await getDatabase()
      .db.insert(scannerAuthVerifications)
      .values([
        {
          id: "pending-p5-linked-link",
          identifier: "pending-linked-hash",
          value: JSON.stringify({ email: "p5-scanner@example.com" }),
          expiresAt: new Date(Date.now() + 3_600_000),
        },
        {
          id: "pending-p5-unrelated-link",
          identifier: "pending-unrelated-hash",
          value: JSON.stringify({ email: "unrelated@example.com" }),
          expiresAt: new Date(Date.now() + 3_600_000),
        },
      ]);
    await expect(
      completeLeadDeletion({ leadId, provider }),
    ).resolves.toMatchObject({
      provider: { detachedCount: 1, customersDeleted: 1 },
      identity: { status: "deleted" },
      database: { status: "anonymized", scanCount: 1 },
    });
    expect(
      (await getDatabase().db.select().from(scannerAuthUsers)).length,
    ).toBe(0);
    expect(
      (await getDatabase().db.select().from(scannerAuthVerifications)).map(
        (row) => row.id,
      ),
    ).toEqual(["pending-p5-unrelated-link"]);
    expect(
      await provider.retrievePaymentMethod(setupReadback.paymentMethodId!),
    ).toMatchObject({ customerId: null });
    expect(await provider.retrieveCustomer(setupReadback.customerId)).toEqual({
      id: setupReadback.customerId,
      deleted: true,
    });

    const { db } = getDatabase();
    const anonymizedLead = (
      await db.select().from(leads).where(eq(leads.id, leadId))
    )[0]!;
    expect(anonymizedLead).toMatchObject({
      emailNormalizedCiphertext: "deleted",
      emailLookupHash: `deleted:${leadId}`,
      role: "deleted",
      name: null,
      volumeBucket: null,
    });
    expect(anonymizedLead.anonymizedAt).toBeInstanceOf(Date);
    expect(anonymizedLead.firstSessionId).not.toBe(originalSessionId);
    expect((await db.select().from(paymentSignals)).length).toBe(0);
    expect((await db.select().from(leadScans)).length).toBe(0);
    expect((await db.select().from(waitlistEntries)).length).toBe(0);
    expect((await db.select().from(deliveryOutbox)).length).toBe(0);
    const anonymizedScan = (
      await db.select().from(scans).where(eq(scans.id, scanId))
    )[0]!;
    expect(anonymizedScan).toMatchObject({
      leadId: null,
      sessionId: anonymizedLead.firstSessionId,
      targetHost: "deleted.invalid",
      canonicalTargetUrl: "redacted://deleted",
    });
    const revokedShare = (await db.select().from(scanShares))[0]!;
    expect(revokedShare).toMatchObject({
      status: "revoked",
      allowIndexing: false,
      publicSnapshot: { anonymized: true },
    });
    expect(
      (await db.select().from(reportSessions))[0]?.revokedAt,
    ).toBeInstanceOf(Date);
    expect((await db.select().from(analyticsEvents))[0]?.leadId).toBeNull();
    await expect(
      getOwnedCardSignalForReport(scanId, sessionToken),
    ).resolves.toBeUndefined();
    await expect(
      completeLeadDeletion({ leadId, provider }),
    ).resolves.toMatchObject({
      provider: { detachedCount: 0, customersDeleted: 0 },
      identity: { status: "not_linked" },
      database: { status: "already_anonymized" },
    });
    expect(
      (await getDatabase().db.select().from(scannerAuthUsers)).length,
    ).toBe(0);
  });

  it("removes an unlinked old scanner identity and pending link when deleting its lead", async () => {
    const { db } = getDatabase();
    const config = getServerConfig();
    const email = "old-orphan-scanner@example.com";
    const id = createUuidV7();
    const sessionId = createUuidV7();
    const userId = createUuidV7();
    await db.insert(sessions).values({
      id: sessionId,
      anonymousIdHash: `orphan-session-${sessionId}`,
    });
    await db.insert(scannerAuthUsers).values({
      id: userId,
      email,
      emailVerified: true,
      name: "",
    });
    await db.insert(leads).values({
      id,
      scannerAuthUserId: null,
      emailNormalizedCiphertext: encryptEmail(email, config.encryptionKey),
      emailLookupHash: hmacHex(config.hmacSecret, "email", email),
      role: "developer",
      firstSegment: "owner",
      firstSessionId: sessionId,
      verifiedAt: new Date(),
    });
    await db.insert(reportSessions).values({
      id: createUuidV7(),
      leadId: id,
      sessionTokenHash: sha256("old-orphan-report-cookie"),
      expiresAt: new Date(Date.now() + 86_400_000),
    });
    await db.insert(scannerAuthVerifications).values({
      id: `pending-old-orphan-${id}`,
      identifier: `pending-old-orphan-${id}`,
      value: JSON.stringify({ email }),
      expiresAt: new Date(Date.now() + 3_600_000),
    });
    await expect(completeLeadDeletion({ leadId: id })).resolves.toMatchObject({
      identity: { status: "deleted" },
      database: { status: "anonymized" },
    });
    expect(
      await db
        .select()
        .from(scannerAuthUsers)
        .where(eq(scannerAuthUsers.id, userId)),
    ).toHaveLength(0);
    expect(
      await db
        .select()
        .from(scannerAuthVerifications)
        .where(eq(scannerAuthVerifications.id, `pending-old-orphan-${id}`)),
    ).toHaveLength(0);
    expect(
      (
        await db
          .select()
          .from(reportSessions)
          .where(eq(reportSessions.leadId, id))
      )[0]?.revokedAt,
    ).toBeInstanceOf(Date);
  });

  it("refuses to delete a linked identity whose email differs from the lead", async () => {
    const { db } = getDatabase();
    const config = getServerConfig();
    const id = createUuidV7();
    const sessionId = createUuidV7();
    const userId = createUuidV7();
    await db.insert(sessions).values({
      id: sessionId,
      anonymousIdHash: `mismatch-session-${sessionId}`,
    });
    await db.insert(scannerAuthUsers).values({
      id: userId,
      email: "unrelated-identity@example.com",
      emailVerified: true,
      name: "",
    });
    await db.insert(leads).values({
      id,
      scannerAuthUserId: userId,
      emailNormalizedCiphertext: encryptEmail(
        "correct-lead@example.com",
        config.encryptionKey,
      ),
      emailLookupHash: hmacHex(
        config.hmacSecret,
        "email",
        "correct-lead@example.com",
      ),
      role: "developer",
      firstSegment: "owner",
      firstSessionId: sessionId,
    });
    await expect(completeLeadDeletion({ leadId: id })).rejects.toThrow(
      "lead_email_identity_mismatch",
    );
    expect(
      await db
        .select()
        .from(scannerAuthUsers)
        .where(eq(scannerAuthUsers.id, userId)),
    ).toHaveLength(1);
    expect(
      (await db.select().from(leads).where(eq(leads.id, id)))[0]?.anonymizedAt,
    ).toBeNull();
  });

  it("rechecks retention eligibility after a lead verifies while cleanup waits", async () => {
    const { db } = getDatabase();
    const id = createUuidV7();
    const sessionId = createUuidV7();
    const now = new Date();
    await db.insert(sessions).values({
      id: sessionId,
      anonymousIdHash: `retention-race-${sessionId}`,
    });
    await db.insert(leads).values({
      id,
      emailNormalizedCiphertext: "synthetic-retention-race",
      emailLookupHash: `retention-race-${id}`,
      role: "developer",
      firstSegment: "owner",
      firstSessionId: sessionId,
      createdAt: new Date(now.getTime() - 31 * 86_400_000),
    });
    let markWaiting!: () => void;
    let releaseWaiting!: () => void;
    const waiting = new Promise<void>((resolve) => {
      markWaiting = resolve;
    });
    const continueCleanup = new Promise<void>((resolve) => {
      releaseWaiting = resolve;
    });
    const cleanup = runRetentionCleanup(db, {
      now,
      beforeLeadAnonymize: async () => {
        markWaiting();
        await continueCleanup;
      },
      beforeLeadAnonymizeInTransaction: async () => {},
    });
    await waiting;
    await db
      .update(leads)
      .set({ verifiedAt: new Date() })
      .where(eq(leads.id, id));
    releaseWaiting();
    expect((await cleanup).leadsAnonymized).toBe(0);
    const retained = (
      await db.select().from(leads).where(eq(leads.id, id))
    )[0]!;
    expect(retained.verifiedAt).toBeInstanceOf(Date);
    expect(retained.anonymizedAt).toBeNull();
  });

  it("executes 7-day token and 30-day unverified-lead retention idempotently", async () => {
    const { db } = getDatabase();
    const now = new Date("2026-07-12T12:00:00.000Z");
    const verifiedSessionId = createUuidV7();
    const verifiedLeadId = createUuidV7();
    const retentionScanId = createUuidV7();
    const unverifiedSessionId = createUuidV7();
    const unverifiedLeadId = createUuidV7();
    await db.insert(sessions).values([
      {
        id: verifiedSessionId,
        anonymousIdHash: "retention-verified-session",
      },
      {
        id: unverifiedSessionId,
        anonymousIdHash: "retention-unverified-session",
      },
    ]);
    await db.insert(leads).values([
      {
        id: verifiedLeadId,
        emailNormalizedCiphertext: "verified-encrypted",
        emailLookupHash: "retention-verified-email",
        role: "owner",
        verifiedAt: now,
        firstSegment: "owner",
        firstSessionId: verifiedSessionId,
      },
      {
        id: unverifiedLeadId,
        emailNormalizedCiphertext: encryptEmail(
          "retention-unverified@example.com",
          getServerConfig().encryptionKey,
        ),
        emailLookupHash: hmacHex(
          getServerConfig().hmacSecret,
          "email",
          "retention-unverified@example.com",
        ),
        role: "owner",
        createdAt: new Date(now.getTime() - 31 * 86_400_000),
        firstSegment: "owner",
        firstSessionId: unverifiedSessionId,
      },
    ]);
    await db.insert(scans).values({
      id: retentionScanId,
      sessionId: verifiedSessionId,
      leadId: verifiedLeadId,
      segment: "owner",
      rubricVersion: "gtm-v1.0.0",
      submittedUrlRedacted: "https://retention.example/",
      canonicalTargetUrl: "https://retention.example/",
      targetHost: "retention.example",
      targetHash: "retention-target",
      accessTokenHash: "retention-access",
      accessTokenExpiresAt: new Date(now.getTime() + 86_400_000),
      idempotencyKeyHash: "retention-idem",
      idempotencyBodyHash: "retention-body",
    });
    const oldTokenId = createUuidV7();
    const freshTokenId = createUuidV7();
    await db.insert(verificationTokens).values([
      {
        id: oldTokenId,
        leadId: verifiedLeadId,
        scanId: retentionScanId,
        tokenHash: "retention-old-token",
        expiresAt: new Date(now.getTime() - 9 * 86_400_000),
        usedAt: new Date(now.getTime() - 8 * 86_400_000),
      },
      {
        id: freshTokenId,
        leadId: verifiedLeadId,
        scanId: retentionScanId,
        tokenHash: "retention-fresh-token",
        expiresAt: new Date(now.getTime() + 86_400_000),
      },
    ]);
    await db.insert(registrationIntents).values({
      id: createUuidV7(),
      scanId: retentionScanId,
      sessionId: verifiedSessionId,
      callbackStateHash: "retention-expired-intent-state",
      emailNormalizedCiphertext: "expired-intent-email-ciphertext",
      emailLookupHash: "expired-intent-email-hash",
      phoneE164Ciphertext: "expired-intent-phone-ciphertext",
      phoneLookupHash: "expired-intent-phone-hash",
      role: "owner",
      datasetReuseAcknowledged: true,
      expiresAt: new Date(now.getTime() - 9 * 86_400_000),
      consumedAt: new Date(now.getTime() - 8 * 86_400_000),
    });
    await db.insert(rateLimitEvents).values({
      id: createUuidV7(),
      keyHash: "expired-rolling-rate",
      kind: "scan_ip_hour",
      occurredAt: new Date(now.getTime() - 7_200_000),
      expiresAt: new Date(now.getTime() - 3_600_000),
    });
    await db.insert(rateWindows).values({
      keyHash: "expired-fixed-rate",
      kind: "scan_target_day",
      windowStart: new Date(now.getTime() - 2 * 86_400_000),
      expiresAt: new Date(now.getTime() - 86_400_000),
    });

    await db.insert(scannerAuthVerifications).values({
      id: "expired-p5-scanner-link",
      identifier: "expired-link-hash",
      value: JSON.stringify({ email: "pending@example.com" }),
      expiresAt: new Date(now.getTime() - 8 * 86_400_000),
    });
    await db.insert(scannerAuthVerifications).values({
      id: "pending-p5-legacy-link",
      identifier: "pending-legacy-hash",
      value: JSON.stringify({ email: "retention-unverified@example.com" }),
      expiresAt: new Date(now.getTime() + 3_600_000),
    });

    await expect(
      executeRetentionCleanup({
        now,
        batchSize: 10,
        provider,
      }),
    ).resolves.toEqual({
      merchantApplicationsDeleted: 0,
      verificationTokensDeleted: 1,
      registrationIntentsDeleted: 1,
      rateLimitRowsDeleted: 2,
      leadsAnonymized: 1,
      candidatesProcessed: 1,
      expiredScannerAuthLinks: 1,
    });
    expect(
      (
        await db
          .select({ id: verificationTokens.id })
          .from(verificationTokens)
          .where(eq(verificationTokens.id, freshTokenId))
      )[0]?.id,
    ).toBe(freshTokenId);
    expect(
      (
        await db
          .select({ anonymizedAt: leads.anonymizedAt })
          .from(leads)
          .where(eq(leads.id, unverifiedLeadId))
      )[0]?.anonymizedAt,
    ).toBeInstanceOf(Date);
    expect(
      await db
        .select()
        .from(scannerAuthVerifications)
        .where(eq(scannerAuthVerifications.id, "pending-p5-legacy-link")),
    ).toHaveLength(0);
    await expect(
      executeRetentionCleanup({
        now,
        batchSize: 10,
        provider,
      }),
    ).resolves.toEqual({
      merchantApplicationsDeleted: 0,
      verificationTokensDeleted: 0,
      registrationIntentsDeleted: 0,
      rateLimitRowsDeleted: 0,
      leadsAnonymized: 0,
      candidatesProcessed: 0,
      expiredScannerAuthLinks: 0,
    });

    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("EMAIL_PROVIDER", "disabled");
    vi.stubEnv("REGISTRATION_ENABLED", "false");
    await expect(
      executeRetentionCleanup({ now, batchSize: 10, provider }),
    ).resolves.toMatchObject({ expiredScannerAuthLinks: 0 });
    vi.unstubAllEnvs();
  });
});
