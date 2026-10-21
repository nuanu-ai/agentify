import { createServer, type Server, type ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";

import {
  consentSnapshots,
  createDatabase,
  createUuidV7,
  leadScans,
  leads,
  migrateDatabase,
  rateLimitEvents,
  rateWindows,
  registrationIntents,
  scannerIdentityDeletionOperations,
  scanShares,
  scans,
  sessions,
  waitlistEntries,
} from "@agentify/scanner-database";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { visitorOf } from "./auth";
import { encryptSensitiveValue, hmacHex } from "./crypto";
import { getDatabase } from "./database";
import { getOperatorDashboard } from "./operator-dashboard";
import { executeRetentionCleanup } from "./privacy";
import {
  requestScannerIdentityDeletion,
  retryPendingScannerIdentityDeletions,
  runScannerIdentityDeletionOperation,
} from "./scanner-identity-deletion";

const connectionString = process.env.MIGRATION_TEST_DATABASE_URL;
if (!connectionString?.includes("_migration_test")) {
  throw new Error("P5 integration requires a dedicated *_migration_test database");
}
process.env.DATABASE_URL = connectionString;
process.env.APP_BASE_URL = "http://localhost:3000";
const tokenHmacSecret = "p5-integration-hmac-secret-with-at-least-32-bytes";
process.env.TOKEN_HMAC_SECRET = tokenHmacSecret;
process.env.EMAIL_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
process.env.REPORT_IDENTITY_SECRET = "d".repeat(32);
process.env.DASHBOARD_IDENTITY_URL = "http://127.0.0.1:1";
process.env.ANALYTICS_RUNTIME_ENV = "test";
process.env.ANALYTICS_SERVER_DELIVERY_ENABLED = "true";
process.env.POSTHOG_API_KEY = "p5-posthog-test-key";
process.env.POSTHOG_DESTINATION_ENV = "test";
process.env.META_CAPI_ENABLED = "false";

const migrationsFolder = fileURLToPath(
  new URL("../../../../packages/scanner-database/migrations", import.meta.url),
);
const admin = createDatabase(connectionString, { max: 1 });
let dashboardServer: Server | undefined;
let sellerDashboardMode: "unavailable" | "retained" | "deleted" = "retained";
let dashboardDelayMs = 0;
let sellerDashboardDeleteRequests = 0;

/**
 * The sessions the stand-in dashboard answers for, by cookie value. A privacy
 * deletion of a person who owns no merchant takes theirs with them.
 */
const SESSION_COOKIE = "__Host-agentify.session_token";
const dashboardSessions = new Map<string, string>();

/** A browser signed in as this address, as the dashboard would answer for it. */
function signedInAs(email: string): string {
  const value = `p5-session-${dashboardSessions.size + 1}`;
  dashboardSessions.set(value, email);
  return `${SESSION_COOKIE}=${value}`;
}

function respondJson(response: ServerResponse, status: number, body: object) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

function onlyRow<T>(rows: readonly T[]): T {
  const [row] = rows;
  if (!row) throw new Error("a query that must return one row returned none");
  return row;
}

async function createLeadFixture(label: string, input: { verified?: boolean } = {}) {
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
    },
    source: "test",
  });
  await db.update(sessions).set({ consentSnapshotId: consentId }).where(eq(sessions.id, sessionId));
  await db.insert(leads).values({
    id: leadId,
    emailNormalizedCiphertext: encryptSensitiveValue(email, Buffer.alloc(32, 7)),
    emailLookupHash: hmacHex(tokenHmacSecret, "email", email),
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
  const server = createServer(async (request, response) => {
    if (
      request.url !== "/internal/report-identity" ||
      request.method !== "POST" ||
      request.headers.authorization !== `Bearer ${process.env.REPORT_IDENTITY_SECRET}`
    ) {
      respondJson(response, 404, { error: "not_found" });
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
      operation?: string;
      cookie?: string;
    };
    if (body.operation === "session") {
      const value = (body.cookie ?? "").split(`${SESSION_COOKIE}=`)[1]?.split(";")[0] ?? "";
      const email = dashboardSessions.get(value);
      respondJson(
        response,
        200,
        email === undefined
          ? { status: "signed_out" }
          : { status: "signed_in", email, operator: false, request: null, set_cookie: [] },
      );
      return;
    }
    if (body.operation !== "delete") {
      respondJson(response, 200, { status: "refused" });
      return;
    }
    sellerDashboardDeleteRequests += 1;
    if (dashboardDelayMs) {
      await new Promise((resolve) => setTimeout(resolve, dashboardDelayMs));
    }
    if (sellerDashboardMode === "unavailable") {
      respondJson(response, 503, { status: "unavailable" });
    } else {
      respondJson(response, 200, { status: sellerDashboardMode });
    }
  });
  dashboardServer = server;
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server_address");
  process.env.DASHBOARD_IDENTITY_URL = `http://127.0.0.1:${address.port}`;
}, 30_000);

afterAll(async () => {
  const server = dashboardServer;
  if (server?.listening) {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
  await getDatabase().pool.end();
  await admin.pool.query(
    "drop schema if exists public cascade; drop schema if exists drizzle cascade; create schema public",
  );
  await admin.pool.end();
});

describe("P5 privacy and terminal scanner identity deletion", () => {
  it("revokes locally during dashboard outage, then completes retained-person deletion", async () => {
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
    const cookieHeader = signedInAs(fixture.email);
    await expect(visitorOf(cookieHeader)).resolves.toMatchObject({ leadId: fixture.leadId });

    sellerDashboardMode = "unavailable";
    await expect(requestScannerIdentityDeletion({ leadId: fixture.leadId })).resolves.toBe(
      "requested",
    );
    const blockedLead = onlyRow(
      await getDatabase().db.select().from(leads).where(eq(leads.id, fixture.leadId)),
    );
    expect(blockedLead.deletionRequestedAt).toBeInstanceOf(Date);
    expect(blockedLead.anonymizedAt).toBeNull();
    // The reports close the moment the deletion is asked for, whether or not
    // the dashboard has answered yet: the session still reads, and it owns
    // nothing any more.
    await expect(visitorOf(cookieHeader)).resolves.toMatchObject({
      kind: "person",
      leadId: null,
    });

    const operation = onlyRow(
      await getDatabase()
        .db.select()
        .from(scannerIdentityDeletionOperations)
        .where(eq(scannerIdentityDeletionOperations.leadId, fixture.leadId)),
    );
    await getDatabase()
      .db.update(scannerIdentityDeletionOperations)
      .set({ leaseExpiresAt: new Date(Date.now() - 1) })
      .where(eq(scannerIdentityDeletionOperations.operationId, operation.operationId));
    sellerDashboardMode = "retained";
    await expect(
      runScannerIdentityDeletionOperation({
        operationId: operation.operationId,
      }),
    ).resolves.toBe("completed");

    const deletedLead = onlyRow(
      await getDatabase().db.select().from(leads).where(eq(leads.id, fixture.leadId)),
    );
    expect(deletedLead.emailNormalizedCiphertext).toBe("deleted");
    expect(deletedLead.anonymizedAt).toBeInstanceOf(Date);
    expect(
      await getDatabase().db.select().from(leadScans).where(eq(leadScans.leadId, fixture.leadId)),
    ).toEqual([]);
    expect(
      await getDatabase()
        .db.select()
        .from(waitlistEntries)
        .where(eq(waitlistEntries.leadId, fixture.leadId)),
    ).toEqual([]);
    expect(
      (await getDatabase().db.select().from(scans).where(eq(scans.id, fixture.scanId)))[0],
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
      (
        await getDatabase()
          .db.select()
          .from(scannerIdentityDeletionOperations)
          .where(eq(scannerIdentityDeletionOperations.operationId, operation.operationId))
      )[0],
    ).toMatchObject({
      dashboardResult: "retained",
      completedAt: expect.any(Date),
    });
  });

  it("uses the database lease so concurrent resident retries delete once", async () => {
    const fixture = await createLeadFixture("deletion-lease");
    sellerDashboardMode = "unavailable";
    await requestScannerIdentityDeletion({ leadId: fixture.leadId });
    const operation = onlyRow(
      await getDatabase()
        .db.select()
        .from(scannerIdentityDeletionOperations)
        .where(eq(scannerIdentityDeletionOperations.leadId, fixture.leadId)),
    );
    await getDatabase()
      .db.update(scannerIdentityDeletionOperations)
      .set({ leaseExpiresAt: new Date(Date.now() - 1) })
      .where(eq(scannerIdentityDeletionOperations.operationId, operation.operationId));

    sellerDashboardMode = "deleted";
    dashboardDelayMs = 75;
    const before = sellerDashboardDeleteRequests;
    const results = await Promise.all([
      runScannerIdentityDeletionOperation({
        operationId: operation.operationId,
      }),
      runScannerIdentityDeletionOperation({
        operationId: operation.operationId,
      }),
    ]);
    dashboardDelayMs = 0;
    expect(results.sort()).toEqual(["completed", "not_found"]);
    expect(sellerDashboardDeleteRequests - before).toBe(1);
    await expect(retryPendingScannerIdentityDeletions()).resolves.toBe(0);
  });

  it("refuses dashboard deletion when encrypted email and lookup hash disagree", async () => {
    const fixture = await createLeadFixture("deletion-mismatch");
    await getDatabase()
      .db.update(leads)
      .set({
        emailNormalizedCiphertext: encryptSensitiveValue(
          "different-owner@example.com",
          Buffer.alloc(32, 7),
        ),
      })
      .where(eq(leads.id, fixture.leadId));
    const beforeRequests = sellerDashboardDeleteRequests;
    await expect(requestScannerIdentityDeletion({ leadId: fixture.leadId })).resolves.toBe(
      "requested",
    );
    expect(sellerDashboardDeleteRequests).toBe(beforeRequests);
    const lead = onlyRow(
      await getDatabase().db.select().from(leads).where(eq(leads.id, fixture.leadId)),
    );
    expect(lead.deletionRequestedAt).toBeInstanceOf(Date);
    expect(lead.anonymizedAt).toBeNull();
  });

  it("leaves a person who confirms their address while the retention cleanup runs as they are", async () => {
    const fixture = await createLeadFixture("retention-race", {
      verified: false,
    });
    // The oldest unverified lead, so a cleanup of one reaches it first.
    await getDatabase()
      .db.update(leads)
      .set({ createdAt: new Date("2000-01-01T00:00:00.000Z") })
      .where(eq(leads.id, fixture.leadId));
    const confirming = await admin.pool.connect();
    try {
      await confirming.query("begin");
      await confirming.query("select id from leads where id = $1 for update", [fixture.leadId]);
      const confirmingPid = (
        await confirming.query<{ pid: number }>("select pg_backend_pid() as pid")
      ).rows[0]?.pid;
      const cleanup = executeRetentionCleanup({ batchSize: 1 });
      // The cleanup has listed the lead and now waits for the confirmation.
      await expect
        .poll(
          async () =>
            (
              await getDatabase().pool.query<{ waiting: number }>(
                "select count(*)::int as waiting from pg_stat_activity where $1 = any(pg_blocking_pids(pid))",
                [confirmingPid],
              )
            ).rows[0]?.waiting,
          { timeout: 5_000, interval: 20 },
        )
        .toBe(1);
      await confirming.query("update leads set verified_at = now() where id = $1", [
        fixture.leadId,
      ]);
      await confirming.query("commit");

      await expect(cleanup).resolves.toMatchObject({ candidatesProcessed: 1, leadsAnonymized: 0 });
    } finally {
      confirming.release();
    }
    const lead = onlyRow(
      await getDatabase().db.select().from(leads).where(eq(leads.id, fixture.leadId)),
    );
    expect(lead.anonymizedAt).toBeNull();
    expect(lead.verifiedAt).toBeInstanceOf(Date);
  });

  it("expires registration and rate evidence at its retention idempotently", async () => {
    const fixture = await createLeadFixture("retention-evidence");
    const now = new Date("2026-09-17T12:00:00.000Z");
    await getDatabase()
      .db.insert(registrationIntents)
      .values({
        id: createUuidV7(),
        scanId: fixture.scanId,
        sessionId: fixture.sessionId,
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

    await expect(executeRetentionCleanup({ now, batchSize: 10 })).resolves.toMatchObject({
      registrationIntentsDeleted: 1,
      rateLimitRowsDeleted: 2,
    });
    await expect(executeRetentionCleanup({ now, batchSize: 10 })).resolves.toMatchObject({
      registrationIntentsDeleted: 0,
      rateLimitRowsDeleted: 0,
    });
  });
});

describe("the operator page", () => {
  it("reads a database the migrations built, with nothing installed beside them", async () => {
    const dashboard = await getOperatorDashboard();
    expect(dashboard.daily).toHaveLength(30);
    expect(dashboard.overview.scansTotal).toBeGreaterThan(0);
    expect(dashboard.recentScans.length).toBeLessThanOrEqual(50);
  });

  it("counts a registration from its record, whether or not an event was kept for it", async () => {
    // A visitor who allowed no measurement registers and leaves the record of
    // the registration and no event; the operator still counts them.
    const registrations = (dashboard: Awaited<ReturnType<typeof getOperatorDashboard>>) => [
      dashboard.overview.verifiedRegistrations30d,
      dashboard.daily.reduce((sum, day) => sum + day.verifiedRegistrations, 0),
    ];
    const [overviewBefore, dailyBefore] = registrations(await getOperatorDashboard());
    await createLeadFixture("operator-counted-registration");
    expect(registrations(await getOperatorDashboard())).toEqual([
      (overviewBefore ?? 0) + 1,
      (dailyBefore ?? 0) + 1,
    ]);
  });
});
