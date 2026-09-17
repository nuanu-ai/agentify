import { createServer, type Server, type ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";

import {
  analyticsEvents,
  consentSnapshots,
  createDatabase,
  createUuidV7,
  deliveryOutbox,
  leadScans,
  leads,
  merchantApplications,
  migrateDatabase,
  paymentSignals,
  rateLimitEvents,
  rateWindows,
  registrationIntents,
  reportSessions,
  runRetentionCleanup,
  scannerIdentityCompletions,
  scannerIdentityDeletionOperations,
  scannerRecoveryIntents,
  scanShares,
  scans,
  sessions,
  waitlistEntries,
  webhookReceipts,
} from "@agentify/scanner-database";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { encryptEmail, hmacHex, sha256 } from "./crypto";
import { getDatabase } from "./database";
import { executeRetentionCleanup } from "./privacy";
import {
  requestScannerIdentityDeletion,
  retryPendingScannerIdentityDeletions,
  runScannerIdentityDeletionOperation,
} from "./scanner-identity-deletion";
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
process.env.REPORT_IDENTITY_SECRET = "d".repeat(32);
process.env.CABINET_IDENTITY_URL = "http://127.0.0.1:1";
process.env.CARD_SIGNAL_ENABLED = "true";
process.env.STRIPE_ADAPTER = "local";
process.env.STRIPE_WEBHOOK_SECRET = "p5-webhook-secret";
process.env.ANALYTICS_RUNTIME_ENV = "test";
process.env.ANALYTICS_SERVER_DELIVERY_ENABLED = "true";
process.env.POSTHOG_API_KEY = "p5-posthog-test-key";
process.env.POSTHOG_DESTINATION_ENV = "test";
process.env.META_CAPI_ENABLED = "false";

const migrationsFolder = fileURLToPath(
  new URL("../../../../packages/scanner-database/migrations", import.meta.url),
);
const admin = createDatabase(connectionString, { max: 1 });
const provider = new LocalStripeCardSignalProvider("p5-webhook-secret");
let cabinetServer: Server;
let cabinetMode: "unavailable" | "retained" | "deleted" = "retained";
let cabinetDelayMs = 0;
let cabinetDeleteRequests = 0;

function respondJson(response: ServerResponse, status: number, body: object) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

async function createLeadFixture(
  label: string,
  input: { verified?: boolean } = {},
) {
  const { db } = getDatabase();
  const sessionId = createUuidV7();
  const consentId = createUuidV7();
  const scanId = createUuidV7();
  const leadId = createUuidV7();
  const email = `${label}@example.com`;
  await db.insert(sessions).values({
    id: sessionId,
    anonymousIdHash: `p5-${label}-${sessionId}`,
  });
  await db.insert(consentSnapshots).values({
    id: consentId,
    sessionId,
    policyVersion: "phase-a-v2",
    categories: {
      essential_processing: true,
      product_analytics: true,
      card_signal: true,
    },
    source: "test",
  });
  await db
    .update(sessions)
    .set({ consentSnapshotId: consentId })
    .where(eq(sessions.id, sessionId));
  await db.insert(leads).values({
    id: leadId,
    emailNormalizedCiphertext: encryptEmail(email, Buffer.alloc(32, 7)),
    emailLookupHash: hmacHex(process.env.TOKEN_HMAC_SECRET!, "email", email),
    role: "business_owner",
    verifiedAt: input.verified === false ? null : new Date(),
    firstSegment: "owner",
    firstSessionId: sessionId,
  });
  await db.insert(scans).values({
    id: scanId,
    sessionId,
    leadId,
    segment: "owner",
    rubricVersion: "gtm-v1.0.0",
    submittedUrlRedacted: `https://${label}.example/`,
    canonicalTargetUrl: `https://${label}.example/`,
    targetHost: `${label}.example`,
    targetHash: `target-${label}-${scanId}`,
    status: "completed",
    score: 70,
    coverage: "1.000",
    level: "ahead_of_market",
    applicableWeight: "100",
    earnedWeight: "70",
    finishedAt: new Date(),
    accessTokenHash: `access-${label}-${scanId}`,
    accessTokenExpiresAt: new Date(Date.now() + 86_400_000),
    idempotencyKeyHash: `idem-${label}-${scanId}`,
    idempotencyBodyHash: `body-${label}-${scanId}`,
  });
  await db.insert(leadScans).values({
    leadId,
    scanId,
    siteOwnershipClaim: true,
  });
  await db.insert(waitlistEntries).values({
    id: createUuidV7(),
    leadId,
    scanId,
  });
  return { sessionId, consentId, scanId, leadId, email };
}

beforeAll(async () => {
  await admin.pool.query(
    "drop schema if exists public cascade; drop schema if exists drizzle cascade; create schema public",
  );
  await migrateDatabase(admin.db, migrationsFolder);
  await admin.pool.query(
    "grant usage on schema public to agentify_web, agentify_privacy, agentify_worker, agentify_dashboard",
  );
  cabinetServer = createServer(async (request, response) => {
    if (
      request.url !== "/internal/report-identity" ||
      request.method !== "POST" ||
      request.headers.authorization !==
        `Bearer ${process.env.REPORT_IDENTITY_SECRET}`
    ) {
      respondJson(response, 404, { error: "not_found" });
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
      operation?: string;
    };
    if (body.operation !== "delete") {
      respondJson(response, 200, { status: "refused" });
      return;
    }
    cabinetDeleteRequests += 1;
    if (cabinetDelayMs) {
      await new Promise((resolve) => setTimeout(resolve, cabinetDelayMs));
    }
    if (cabinetMode === "unavailable") {
      respondJson(response, 503, { status: "unavailable" });
    } else {
      respondJson(response, 200, { status: cabinetMode });
    }
  });
  await new Promise<void>((resolve) =>
    cabinetServer.listen(0, "127.0.0.1", resolve),
  );
  const address = cabinetServer.address();
  if (!address || typeof address === "string")
    throw new Error("server_address");
  process.env.CABINET_IDENTITY_URL = `http://127.0.0.1:${address.port}`;
}, 30_000);

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    cabinetServer.close((error) => (error ? reject(error) : resolve())),
  );
  await getDatabase().pool.end();
  await admin.pool.query(
    "drop schema if exists public cascade; drop schema if exists drizzle cascade; create schema public",
  );
  await admin.pool.end();
});

describe("P5 privacy and terminal scanner identity deletion", () => {
  it("attaches once, hydrates current state, rejects replay drift, and detaches", async () => {
    const fixture = await createLeadFixture("card-lifecycle");
    const sessionToken = "p5-card-lifecycle-report-session";
    await getDatabase()
      .db.insert(reportSessions)
      .values({
        id: createUuidV7(),
        leadId: fixture.leadId,
        sessionTokenHash: sha256(sessionToken),
        expiresAt: new Date(Date.now() + 86_400_000),
      });
    const setup = await setupCardSignal({
      sessionToken,
      scanId: fixture.scanId,
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
      getOwnedCardSignalForReport(fixture.scanId, sessionToken),
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
      getOwnedCardSignalForReport(fixture.scanId, sessionToken),
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
      getOwnedCardSignalForReport(fixture.scanId, sessionToken),
    ).resolves.toMatchObject({
      signalId: signal.id,
      status: "detached",
      clientSecret: null,
    });
  });

  it("revokes locally during cabinet outage, then completes retained-person deletion", async () => {
    const fixture = await createLeadFixture("deletion-outage");
    await getDatabase()
      .db.insert(scanShares)
      .values({
        id: createUuidV7(),
        scanId: fixture.scanId,
        shareSlugHash: `p5-share-${fixture.scanId}`,
        publicSnapshot: {
          host: "deletion-outage.example",
          score: 70,
          level: "ahead_of_market",
          rubric_version: "gtm-v1.0.0",
          generated_at: new Date().toISOString(),
        },
      });
    const customerId = await provider.createCustomer({
      leadId: fixture.leadId,
      idempotencyKey: "deletion-outage-customer",
    });
    const setup = await provider.createSetup({
      customerId,
      leadId: fixture.leadId,
      scanId: fixture.scanId,
      idempotencyKey: "deletion-outage-setup",
    });
    await getDatabase().db.insert(paymentSignals).values({
      id: createUuidV7(),
      leadId: fixture.leadId,
      stripeCustomerId: customerId,
      setupIntentId: setup.id,
      status: "setup_pending",
      consentSnapshotId: fixture.consentId,
    });
    await getDatabase()
      .db.insert(reportSessions)
      .values({
        id: createUuidV7(),
        leadId: fixture.leadId,
        sessionTokenHash: `session-${fixture.leadId}`,
        expiresAt: new Date(Date.now() + 86_400_000),
      });
    await getDatabase()
      .db.insert(scannerRecoveryIntents)
      .values({
        id: createUuidV7(),
        tokenHash: "R".repeat(43),
        stateHash: "a".repeat(64),
        emailLookupHash: hmacHex(
          process.env.TOKEN_HMAC_SECRET!,
          "email",
          fixture.email,
        ),
        leadId: fixture.leadId,
        scanId: fixture.scanId,
        expiresAt: new Date(Date.now() + 60_000),
        activatedAt: new Date(),
      });
    await getDatabase()
      .db.insert(scannerIdentityCompletions)
      .values({
        receiptId: createUuidV7(),
        tokenHash: "S".repeat(43),
        intentKind: "recovery",
        stateHash: "b".repeat(64),
        leadId: fixture.leadId,
        scanId: fixture.scanId,
        completedAt: new Date(),
        retainUntil: new Date(Date.now() + 7 * 86_400_000),
      });

    cabinetMode = "unavailable";
    await expect(
      requestScannerIdentityDeletion({ leadId: fixture.leadId, provider }),
    ).resolves.toBe("requested");
    const blockedLead = (
      await getDatabase()
        .db.select()
        .from(leads)
        .where(eq(leads.id, fixture.leadId))
    )[0]!;
    expect(blockedLead.deletionRequestedAt).toBeInstanceOf(Date);
    expect(blockedLead.anonymizedAt).toBeNull();
    expect(
      (
        await getDatabase()
          .db.select()
          .from(reportSessions)
          .where(eq(reportSessions.leadId, fixture.leadId))
      )[0]?.revokedAt,
    ).toBeInstanceOf(Date);
    expect(
      await getDatabase()
        .db.select()
        .from(scannerRecoveryIntents)
        .where(eq(scannerRecoveryIntents.leadId, fixture.leadId)),
    ).toEqual([]);
    expect((await provider.retrieveCustomer(customerId)).deleted).toBe(false);

    const operation = (
      await getDatabase()
        .db.select()
        .from(scannerIdentityDeletionOperations)
        .where(eq(scannerIdentityDeletionOperations.leadId, fixture.leadId))
    )[0]!;
    await getDatabase()
      .db.update(scannerIdentityDeletionOperations)
      .set({ leaseExpiresAt: new Date(Date.now() - 1) })
      .where(
        eq(
          scannerIdentityDeletionOperations.operationId,
          operation.operationId,
        ),
      );
    cabinetMode = "retained";
    await expect(
      runScannerIdentityDeletionOperation({
        operationId: operation.operationId,
        provider,
      }),
    ).resolves.toBe("completed");

    const deletedLead = (
      await getDatabase()
        .db.select()
        .from(leads)
        .where(eq(leads.id, fixture.leadId))
    )[0]!;
    expect(deletedLead.emailNormalizedCiphertext).toBe("deleted");
    expect(deletedLead.anonymizedAt).toBeInstanceOf(Date);
    expect((await provider.retrieveCustomer(customerId)).deleted).toBe(true);
    expect((await provider.retrieveSetup(setup.id)).status).toBe("canceled");
    expect(
      await getDatabase()
        .db.select()
        .from(paymentSignals)
        .where(eq(paymentSignals.leadId, fixture.leadId)),
    ).toEqual([]);
    expect(
      await getDatabase()
        .db.select()
        .from(leadScans)
        .where(eq(leadScans.leadId, fixture.leadId)),
    ).toEqual([]);
    expect(
      await getDatabase()
        .db.select()
        .from(waitlistEntries)
        .where(eq(waitlistEntries.leadId, fixture.leadId)),
    ).toEqual([]);
    expect(
      (
        await getDatabase()
          .db.select()
          .from(scans)
          .where(eq(scans.id, fixture.scanId))
      )[0],
    ).toMatchObject({
      leadId: null,
      targetHost: "deleted.invalid",
      canonicalTargetUrl: "redacted://deleted",
    });
    expect(
      (
        await getDatabase()
          .db.select()
          .from(scanShares)
          .where(eq(scanShares.scanId, fixture.scanId))
      )[0],
    ).toMatchObject({
      status: "revoked",
      allowIndexing: false,
      publicSnapshot: { anonymized: true },
    });
    expect(
      await getDatabase()
        .db.select()
        .from(scannerIdentityCompletions)
        .where(eq(scannerIdentityCompletions.leadId, fixture.leadId)),
    ).toEqual([]);
    expect(
      (
        await getDatabase()
          .db.select()
          .from(scannerIdentityDeletionOperations)
          .where(
            eq(
              scannerIdentityDeletionOperations.operationId,
              operation.operationId,
            ),
          )
      )[0],
    ).toMatchObject({
      cabinetResult: "retained",
      completedAt: expect.any(Date),
    });
  });

  it("uses the database lease so concurrent resident retries delete once", async () => {
    const fixture = await createLeadFixture("deletion-lease");
    cabinetMode = "unavailable";
    await requestScannerIdentityDeletion({ leadId: fixture.leadId });
    const operation = (
      await getDatabase()
        .db.select()
        .from(scannerIdentityDeletionOperations)
        .where(eq(scannerIdentityDeletionOperations.leadId, fixture.leadId))
    )[0]!;
    await getDatabase()
      .db.update(scannerIdentityDeletionOperations)
      .set({ leaseExpiresAt: new Date(Date.now() - 1) })
      .where(
        eq(
          scannerIdentityDeletionOperations.operationId,
          operation.operationId,
        ),
      );

    cabinetMode = "deleted";
    cabinetDelayMs = 75;
    const before = cabinetDeleteRequests;
    const results = await Promise.all([
      runScannerIdentityDeletionOperation({
        operationId: operation.operationId,
      }),
      runScannerIdentityDeletionOperation({
        operationId: operation.operationId,
      }),
    ]);
    cabinetDelayMs = 0;
    expect(results.sort()).toEqual(["completed", "not_found"]);
    expect(cabinetDeleteRequests - before).toBe(1);
    await expect(retryPendingScannerIdentityDeletions()).resolves.toBe(0);
  });

  it("refuses cabinet deletion when encrypted email and lookup hash disagree", async () => {
    const fixture = await createLeadFixture("deletion-mismatch");
    await getDatabase()
      .db.update(leads)
      .set({
        emailNormalizedCiphertext: encryptEmail(
          "different-owner@example.com",
          Buffer.alloc(32, 7),
        ),
      })
      .where(eq(leads.id, fixture.leadId));
    const beforeRequests = cabinetDeleteRequests;
    await expect(
      requestScannerIdentityDeletion({ leadId: fixture.leadId }),
    ).resolves.toBe("requested");
    expect(cabinetDeleteRequests).toBe(beforeRequests);
    const lead = (
      await getDatabase()
        .db.select()
        .from(leads)
        .where(eq(leads.id, fixture.leadId))
    )[0]!;
    expect(lead.deletionRequestedAt).toBeInstanceOf(Date);
    expect(lead.anonymizedAt).toBeNull();
  });

  it("rechecks unverified retention eligibility after a concurrent verification", async () => {
    const fixture = await createLeadFixture("retention-race", {
      verified: false,
    });
    const now = new Date();
    await getDatabase()
      .db.update(leads)
      .set({ createdAt: new Date(now.getTime() - 31 * 86_400_000) })
      .where(eq(leads.id, fixture.leadId));
    let markWaiting!: () => void;
    let releaseWaiting!: () => void;
    const waiting = new Promise<void>((resolve) => {
      markWaiting = resolve;
    });
    const continueCleanup = new Promise<void>((resolve) => {
      releaseWaiting = resolve;
    });
    const cleanup = runRetentionCleanup(getDatabase().db, {
      now,
      beforeLeadAnonymize: async () => {
        markWaiting();
        await continueCleanup;
      },
      beforeLeadAnonymizeInTransaction: async () => {},
    });
    await waiting;
    await getDatabase()
      .db.update(leads)
      .set({ verifiedAt: new Date() })
      .where(eq(leads.id, fixture.leadId));
    releaseWaiting();
    expect((await cleanup).leadsAnonymized).toBe(0);
    expect(
      (
        await getDatabase()
          .db.select()
          .from(leads)
          .where(eq(leads.id, fixture.leadId))
      )[0]?.anonymizedAt,
    ).toBeNull();
  });

  it("expires recovery and completion evidence at seven days idempotently", async () => {
    const fixture = await createLeadFixture("retention-evidence");
    const now = new Date("2026-09-17T12:00:00.000Z");
    await getDatabase()
      .db.insert(scannerRecoveryIntents)
      .values([
        {
          id: createUuidV7(),
          stateHash: "c".repeat(64),
          emailLookupHash: hmacHex(
            process.env.TOKEN_HMAC_SECRET!,
            "email",
            fixture.email,
          ),
          leadId: fixture.leadId,
          scanId: fixture.scanId,
          expiresAt: new Date(now.getTime() - 8 * 86_400_000),
        },
        {
          id: createUuidV7(),
          stateHash: "d".repeat(64),
          emailLookupHash: hmacHex(
            process.env.TOKEN_HMAC_SECRET!,
            "email",
            fixture.email,
          ),
          leadId: fixture.leadId,
          scanId: fixture.scanId,
          expiresAt: new Date(now.getTime() + 86_400_000),
        },
      ]);
    await getDatabase()
      .db.insert(scannerIdentityCompletions)
      .values([
        {
          receiptId: createUuidV7(),
          tokenHash: "T".repeat(43),
          intentKind: "registration",
          stateHash: "e".repeat(64),
          leadId: fixture.leadId,
          scanId: fixture.scanId,
          completedAt: new Date(now.getTime() - 8 * 86_400_000),
          retainUntil: new Date(now.getTime() - 1),
        },
        {
          receiptId: createUuidV7(),
          tokenHash: "U".repeat(43),
          intentKind: "recovery",
          stateHash: "f".repeat(64),
          leadId: fixture.leadId,
          scanId: fixture.scanId,
          completedAt: now,
          retainUntil: new Date(now.getTime() + 7 * 86_400_000),
        },
      ]);
    await getDatabase()
      .db.insert(registrationIntents)
      .values({
        id: createUuidV7(),
        scanId: fixture.scanId,
        sessionId: fixture.sessionId,
        callbackStateHash: "1".repeat(64),
        emailNormalizedCiphertext: "expired-registration-email",
        emailLookupHash: "expired-registration-email-hash",
        phoneE164Ciphertext: "expired-registration-phone",
        phoneLookupHash: "expired-registration-phone-hash",
        role: "owner",
        datasetReuseAcknowledged: true,
        expiresAt: new Date(now.getTime() - 9 * 86_400_000),
        consumedAt: new Date(now.getTime() - 8 * 86_400_000),
      });
    await getDatabase()
      .db.insert(rateLimitEvents)
      .values({
        id: createUuidV7(),
        keyHash: "expired-rolling-rate",
        kind: "scan_ip_hour",
        occurredAt: new Date(now.getTime() - 7_200_000),
        expiresAt: new Date(now.getTime() - 3_600_000),
      });
    await getDatabase()
      .db.insert(rateWindows)
      .values({
        keyHash: "expired-fixed-rate",
        kind: "scan_target_day",
        windowStart: new Date(now.getTime() - 2 * 86_400_000),
        expiresAt: new Date(now.getTime() - 86_400_000),
      });
    const expiredApplicationId = createUuidV7();
    const currentApplicationId = createUuidV7();
    await getDatabase()
      .db.insert(merchantApplications)
      .values([
        {
          id: expiredApplicationId,
          idempotencyKeyHash: "expired-application",
          requestHash: "expired-request",
          payloadCiphertext: "expired-ciphertext",
          policyVersion: "merchant-application-2026-09-09",
          expiresAt: new Date(now.getTime() - 1),
        },
        {
          id: currentApplicationId,
          idempotencyKeyHash: "current-application",
          requestHash: "current-request",
          payloadCiphertext: "current-ciphertext",
          policyVersion: "merchant-application-2026-09-09",
          expiresAt: new Date(now.getTime() + 86_400_000),
        },
      ]);

    await expect(
      executeRetentionCleanup({ now, batchSize: 10, provider }),
    ).resolves.toMatchObject({
      merchantApplicationsDeleted: 1,
      registrationIntentsDeleted: 1,
      rateLimitRowsDeleted: 2,
      expiredScannerRecoveryIntents: 1,
      expiredScannerIdentityCompletions: 1,
    });
    expect(
      await getDatabase().db.select().from(scannerRecoveryIntents),
    ).toHaveLength(1);
    expect(
      await getDatabase().db.select().from(scannerIdentityCompletions),
    ).toHaveLength(1);
    expect(
      await getDatabase()
        .db.select()
        .from(merchantApplications)
        .where(eq(merchantApplications.id, currentApplicationId)),
    ).toEqual([
      {
        id: currentApplicationId,
        idempotencyKeyHash: "current-application",
        requestHash: "current-request",
        payloadCiphertext: "current-ciphertext",
        policyVersion: "merchant-application-2026-09-09",
        createdAt: expect.any(Date),
        expiresAt: expect.any(Date),
      },
    ]);
    await expect(
      executeRetentionCleanup({ now, batchSize: 10, provider }),
    ).resolves.toMatchObject({
      merchantApplicationsDeleted: 0,
      registrationIntentsDeleted: 0,
      rateLimitRowsDeleted: 0,
      expiredScannerRecoveryIntents: 0,
      expiredScannerIdentityCompletions: 0,
    });
  });

  it("keeps merchant applications behind their existing RLS boundary", async () => {
    for (const role of ["agentify_web", "agentify_privacy"]) {
      await expect(
        admin.db.transaction(async (tx) => {
          await tx.execute(sql.raw(`set local role ${role}`));
          return tx.execute(
            sql`select id from public.merchant_applications limit 1`,
          );
        }),
      ).resolves.toMatchObject({ rows: [expect.any(Object)] });
    }
    for (const role of ["agentify_worker", "agentify_dashboard"]) {
      try {
        await admin.db.transaction(async (tx) => {
          await tx.execute(sql.raw(`set local role ${role}`));
          return tx.execute(
            sql`select id from public.merchant_applications limit 1`,
          );
        });
        throw new Error("expected_merchant_application_permission_denied");
      } catch (error) {
        const cause = (error as { cause?: unknown }).cause;
        expect(cause instanceof Error ? cause.message : String(error)).toMatch(
          /permission denied/,
        );
      }
    }
  });
});
