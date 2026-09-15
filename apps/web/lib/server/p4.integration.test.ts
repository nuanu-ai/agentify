import { fileURLToPath } from "node:url";

import { CONSENT_POLICY_VERSION } from "@agentify/analytics";
import { CHECK_DEFINITIONS } from "@agentify/scanner-contracts";
import {
  consentSnapshots,
  createDatabase,
  createUuidV7,
  deliveryOutbox,
  leads,
  leadScans,
  registrationIntents,
  reportSessions,
  scannerAuthSessions,
  scannerAuthUsers,
  scannerAuthVerifications,
  migrateDatabase,
  scanChecks,
  scanShares,
  scans,
  sessions,
  verificationTokens,
} from "@agentify/scanner-database";
import { and, eq, isNull, sql } from "drizzle-orm";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { POST as persistAttribution } from "../../app/api/v1/attribution/route";
import { POST as persistConsent } from "../../app/api/v1/consent/route";
import { POST as persistClientEvent } from "../../app/api/v1/events/route";
import { GET as downloadFullPrompt } from "../../app/api/v1/reports/[scanId]/remediation-prompt/download/route";
import { GET as downloadTeaserPrompt } from "../../app/api/v1/scans/[id]/remediation-prompt/download/route";
import { GET as getTeaserPrompt } from "../../app/api/v1/scans/[id]/remediation-prompt/route";
import { GET as previewShare } from "../../app/api/v1/scans/[id]/share-preview/route";
import { POST as publishShare } from "../../app/api/v1/scans/[id]/share/route";
import { POST as acceptScan } from "../../app/api/v1/scans/route";
import { GET as getContactAccess } from "../../app/api/v2/scans/[id]/contact-access/route";
import { POST as finalizeScannerAuth } from "../../app/api/v2/auth/finalize/route";
import { POST as requestScannerRegistration } from "../../app/api/v2/scans/[id]/registrations/route";
import { REPORT_SESSION_COOKIE } from "./auth";
import { encryptEmail, hmacHex, sha256 } from "./crypto";
import { getServerConfig } from "./config";
import { getDatabase } from "./database";
import { getLocalEmailEvidence } from "./email";
import { enqueueScanInTransaction, stopScanQueue } from "./queue";
import { completeLeadDeletion } from "./privacy";
import { sendScannerMagicLink } from "./scanner-auth";
import { consumeScanRateLimits, readRateCount } from "./rate-limit";
import { registerForReport, verifyEmailToken } from "./registration";
import {
  createScannerRegistrationIntent,
  finalizeScannerRegistration,
} from "./scanner-registration";
import {
  createPublicShare,
  getFullReport,
  getPublicShare,
  revokePublicShare,
  saveWaitlistAnswer,
} from "./reporting";
import { authorizeScan, createOrReplayScan } from "./scans";

const connectionString = process.env.MIGRATION_TEST_DATABASE_URL;
if (!connectionString?.includes("_migration_test")) {
  throw new Error(
    "P4 integration requires a dedicated *_migration_test database",
  );
}
process.env.DATABASE_URL = connectionString;
process.env.APP_BASE_URL = "http://localhost:3000";
process.env.TOKEN_HMAC_SECRET =
  "p4-integration-hmac-secret-with-at-least-32-bytes";
process.env.EMAIL_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString("base64");
process.env.EMAIL_PROVIDER = "local";
process.env.LOCAL_EMAIL_EVIDENCE_ENABLED = "true";
process.env.BENCHMARK_ENABLED = "false";
process.env.PUBLIC_SHARE_ENABLED = "true";
process.env.REGISTRATION_ENABLED = "false";
process.env.PARTNER_POSTBACK_ENABLED = "true";

const admin = createDatabase(connectionString, { max: 1 });
const migrationsFolder = fileURLToPath(
  new URL("../../../../packages/scanner-database/migrations", import.meta.url),
);
let scanId = "";
let scanAccessToken = "";
const anonymousToken = "p4-attribution-anonymous-token";

async function createFreshCompletedScan(label: string) {
  const { db } = getDatabase();
  const source = (
    await db.select().from(scans).where(eq(scans.id, scanId))
  )[0]!;
  const sessionId = createUuidV7();
  const id = createUuidV7();
  const accessToken = `fresh-${label}-private-access-token-with-more-than-192-bits`;
  await db.insert(sessions).values({
    id: sessionId,
    anonymousIdHash: `fresh-${label}-${sessionId}`,
  });
  await db.insert(scans).values({
    ...source,
    id,
    sessionId,
    leadId: null,
    targetHash: `fresh-${label}-target`,
    accessTokenHash: sha256(accessToken),
    accessTokenExpiresAt: new Date(Date.now() + 86_400_000),
    idempotencyKeyHash: `fresh-${label}-idem`,
    idempotencyBodyHash: `fresh-${label}-body`,
  });
  return {
    scan: (await db.select().from(scans).where(eq(scans.id, id)))[0]!,
    accessToken,
  };
}

beforeAll(async () => {
  await admin.pool.query(
    "drop schema if exists public cascade; drop schema if exists drizzle cascade; create schema public",
  );
  await migrateDatabase(admin.db, migrationsFolder);
  const { db } = getDatabase();
  const sessionId = createUuidV7();
  const consentId = createUuidV7();
  scanId = createUuidV7();
  scanAccessToken = "scan-access-token-with-more-than-192-random-looking-bits";
  await db.insert(sessions).values({
    id: sessionId,
    anonymousIdHash: hmacHex(
      process.env.TOKEN_HMAC_SECRET!,
      "anonymous",
      anonymousToken,
    ),
  });
  await db.insert(consentSnapshots).values({
    id: consentId,
    sessionId,
    policyVersion: "phase-a-v1",
    categories: { essential_processing: true },
    source: "test",
  });
  await db
    .update(sessions)
    .set({ consentSnapshotId: consentId })
    .where(eq(sessions.id, sessionId));
  await db.insert(scans).values({
    id: scanId,
    sessionId,
    segment: "owner",
    rubricVersion: "gtm-v1.0.0",
    submittedUrlRedacted: "https://example.com/",
    canonicalTargetUrl: "https://example.com/",
    targetHost: "example.com",
    targetHash: "target-hash",
    status: "completed",
    score: 72,
    coverage: "1.000",
    level: "ahead_of_market",
    applicableWeight: "100",
    earnedWeight: "72",
    finishedAt: new Date(),
    accessTokenHash: sha256(scanAccessToken),
    accessTokenExpiresAt: new Date(Date.now() + 86_400_000),
    idempotencyKeyHash: "idem-key",
    idempotencyBodyHash: "idem-body",
  });
  await db.insert(scanChecks).values(
    CHECK_DEFINITIONS.map((check) => ({
      scanId,
      checkId: check.id,
      status:
        check.id === 8 || check.id === 17
          ? ("not_applicable" as const)
          : ("pass" as const),
      nominalWeight: String(check.nominalWeight),
      applicableWeight: String(check.nominalWeight),
      earnedWeight: String(check.nominalWeight),
      summaryCode: `${check.labelCode}_observed`,
      userImpactCode: `${check.labelCode}_impact`,
      fixCode: `${check.labelCode}_fix`,
      durationMs: 5,
      evidence: {
        present: true,
        endpoint_url: "https://private.example/hidden",
      },
    })),
  );
}, 30_000);

afterAll(async () => {
  await stopScanQueue();
  await getDatabase().pool.end();
  await admin.pool.query(
    "drop schema if exists public cascade; drop schema if exists drizzle cascade; create schema public",
  );
  await admin.pool.end();
});

describe("P4 verified report funnel", () => {
  it("derives scheme omission in the route and ignores the legacy header", async () => {
    const submit = async (
      url: string,
      idempotencyKey: string,
      spoofedHeader: string,
      ip: string,
    ) => {
      const response = await acceptScan(
        new NextRequest("http://localhost:3000/api/v1/scans", {
          method: "POST",
          headers: {
            origin: "http://localhost:3000",
            "content-type": "application/json",
            "idempotency-key": idempotencyKey,
            "x-forwarded-for": ip,
            "x-b2a-submitted-without-scheme": spoofedHeader,
          },
          body: JSON.stringify({
            url,
            segment: "owner",
            landing_variant: "owner-v1",
            turnstile_token: null,
          }),
        }),
      );
      expect(response.status).toBe(202);
      return (await response.json()) as { scan_id: string };
    };

    const explicit = await submit(
      "https://explicit-scheme.example/path",
      `explicit-${createUuidV7()}`,
      "true",
      "203.0.113.41",
    );
    const omitted = await submit(
      "omitted-scheme.example/path",
      `omitted-${createUuidV7()}`,
      "false",
      "203.0.113.42",
    );
    const rows = await getDatabase()
      .db.select({
        id: scans.id,
        submittedWithoutScheme: scans.submittedWithoutScheme,
      })
      .from(scans)
      .where(sql`${scans.id} in (${explicit.scan_id}, ${omitted.scan_id})`);
    expect(
      rows.find(({ id }) => id === explicit.scan_id)?.submittedWithoutScheme,
    ).toBe(false);
    expect(
      rows.find(({ id }) => id === omitted.scan_id)?.submittedWithoutScheme,
    ).toBe(true);
  });

  it("keeps registration neutral/idempotent and tokens hash-only", async () => {
    const { db } = getDatabase();
    const attributionRequest = (campaign: string, fbclidHash: string) =>
      new NextRequest("http://localhost:3000/api/v1/attribution", {
        method: "POST",
        headers: {
          origin: "http://localhost:3000",
          cookie: `b2a_anonymous=${anonymousToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          segment: "owner",
          landing_variant: "owner-v1",
          touch: {
            utm_source: "meta",
            utm_campaign: campaign,
            fbclid_hash: fbclidHash,
          },
        }),
      });
    expect(
      (
        await persistAttribution(
          attributionRequest("first-campaign", "a".repeat(64)),
        )
      ).status,
    ).toBe(204);
    expect(
      (
        await persistAttribution(
          attributionRequest("last-campaign", "b".repeat(64)),
        )
      ).status,
    ).toBe(204);
    const attributedSession = (
      await db
        .select()
        .from(sessions)
        .where(
          eq(
            sessions.anonymousIdHash,
            hmacHex(
              process.env.TOKEN_HMAC_SECRET!,
              "anonymous",
              anonymousToken,
            ),
          ),
        )
        .limit(1)
    )[0]!;
    expect(attributedSession).toMatchObject({
      firstUtmCampaign: "first-campaign",
      firstFbclidHash: "a".repeat(64),
      lastUtmCampaign: "last-campaign",
      lastFbclidHash: "b".repeat(64),
    });
    expect(JSON.stringify(attributedSession)).not.toContain("fbclid=");
    const partnerClickId = "Xk8sJ2QpR4vN7bL0aZ9wQg";
    const partnerAttributionRequest = () =>
      new NextRequest("http://localhost:3000/api/v1/attribution", {
        method: "POST",
        headers: {
          origin: "http://localhost:3000",
          cookie: `b2a_anonymous=${anonymousToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          segment: "owner",
          landing_variant: "owner-v1",
          touch: {},
          partner_click_id: partnerClickId,
        }),
      });
    expect(
      (await persistAttribution(partnerAttributionRequest())).headers.get(
        "set-cookie",
      ) ?? "",
    ).not.toContain(`clickid=${partnerClickId}`);
    const consentRequest = (adsMeasurement: boolean) =>
      new NextRequest("http://localhost:3000/api/v1/consent", {
        method: "POST",
        headers: {
          origin: "http://localhost:3000",
          cookie: `b2a_anonymous=${anonymousToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          policy_version: CONSENT_POLICY_VERSION,
          categories: {
            essential_processing: true,
            product_analytics: false,
            ads_measurement: adsMeasurement,
            marketing_email: false,
            dataset_reuse: false,
            card_signal: false,
          },
        }),
      });
    expect((await persistConsent(consentRequest(true))).status).toBe(201);
    expect(
      (await persistAttribution(partnerAttributionRequest())).headers.get(
        "set-cookie",
      ),
    ).toContain(`clickid=${partnerClickId}`);
    const revoked = await persistConsent(consentRequest(false));
    expect(revoked.headers.get("set-cookie")).toMatch(/clickid=;.*Max-Age=0/i);
    const piiAttribution = await persistAttribution(
      new NextRequest("http://localhost:3000/api/v1/attribution", {
        method: "POST",
        headers: {
          origin: "http://localhost:3000",
          cookie: `b2a_anonymous=${anonymousToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          segment: "owner",
          landing_variant: "owner-v1",
          touch: { utm_term: "person@example.com" },
        }),
      }),
    );
    expect(piiAttribution.status).toBe(400);

    const teaserEvent = await persistClientEvent(
      new NextRequest("http://localhost:3000/api/v1/events", {
        method: "POST",
        headers: {
          origin: "http://localhost:3000",
          authorization: `Bearer ${scanAccessToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          event_id: createUuidV7(),
          name: "results_viewed",
          scan_id: scanId,
          properties: {},
        }),
      }),
    );
    expect(teaserEvent.status).toBe(200);
    expect(
      await getDatabase().pool.query<{ count: string }>(
        `select count(*)::text as count
         from delivery_outbox o
         join analytics_events e on e.event_id = o.event_id
         where e.scan_id = $1 and e.name = 'results_viewed'`,
        [scanId],
      ),
    ).toMatchObject({ rows: [{ count: "0" }] });
    const scan = (
      await db.select().from(scans).where(eq(scans.id, scanId)).limit(1)
    )[0]!;
    const body = {
      email: "Owner@Example.com",
      phone: "+14155550123",
      role: "business_owner",
      site_is_mine: true,
      marketing_email_opt_in: false,
      dataset_reuse_acknowledged: true as const,
    };
    await registerForReport(scan, body);
    await registerForReport(scan, body);
    expect(
      (await db.select({ count: sql<number>`count(*)::int` }).from(leads))[0]
        ?.count,
    ).toBe(1);
    expect(
      (
        await db.select({ count: sql<number>`count(*)::int` }).from(leadScans)
      )[0]?.count,
    ).toBe(1);
    const lead = (await db.select().from(leads))[0]!;
    expect(lead.emailNormalizedCiphertext).not.toContain("owner@example.com");
    const storedToken = (
      await db
        .select()
        .from(verificationTokens)
        .where(eq(verificationTokens.scanId, scanId))
    )[0]!;
    expect(storedToken.tokenHash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(storedToken)).not.toContain("api/v1/auth/verify");
  });

  it("stores phone only encrypted and finalizes verified scanner identity once", async () => {
    const { db } = getDatabase();
    const sourceScan = (
      await db.select().from(scans).where(eq(scans.id, scanId)).limit(1)
    )[0]!;
    const supabaseScanId = createUuidV7();
    const supabaseScanAccessToken =
      "supabase-scan-access-token-with-more-than-192-random-looking-bits";
    await db.insert(scans).values({
      ...sourceScan,
      id: supabaseScanId,
      leadId: null,
      targetHash: "p4-supabase-target-hash",
      accessTokenHash: sha256(supabaseScanAccessToken),
      idempotencyKeyHash: "p4-supabase-idempotency-key-hash",
      idempotencyBodyHash: "p4-supabase-idempotency-body-hash",
    });
    const sourceChecks = await db
      .select()
      .from(scanChecks)
      .where(eq(scanChecks.scanId, scanId));
    await db.insert(scanChecks).values(
      sourceChecks.map((check) => ({
        ...check,
        scanId: supabaseScanId,
      })),
    );
    const scan = (
      await db.select().from(scans).where(eq(scans.id, supabaseScanId)).limit(1)
    )[0]!;
    const supabaseEmail = "supabase-new@example.com";
    const partnerClickId = "Xk8sJ2QpR4vN7bL0aZ9wQg";
    const partnerConsentId = createUuidV7();
    await db.insert(consentSnapshots).values({
      id: partnerConsentId,
      sessionId: scan.sessionId,
      policyVersion: "consent-v1.0.0",
      categories: {
        essential_processing: true,
        product_analytics: false,
        ads_measurement: true,
        marketing_email: false,
        dataset_reuse: false,
        card_signal: false,
      },
      source: "test",
    });
    await db
      .update(sessions)
      .set({ consentSnapshotId: partnerConsentId })
      .where(eq(sessions.id, scan.sessionId));
    let redirectUrl = "";
    await createScannerRegistrationIntent(
      scan,
      {
        email: supabaseEmail,
        phone: "+14155550123",
        role: "business_owner",
        site_is_mine: true,
        marketing_email_opt_in: false,
        dataset_reuse_acknowledged: true,
      },
      {
        partnerClickId,
        sendMagicLink: async (_email, redirect) => {
          redirectUrl = redirect;
        },
      },
    );
    const state = new URL(redirectUrl).searchParams.get("state");
    expect(state).toHaveLength(43);
    const emailLookupHash = hmacHex(
      process.env.TOKEN_HMAC_SECRET!,
      "email",
      supabaseEmail,
    );
    const intent = (
      await db
        .select()
        .from(registrationIntents)
        .where(
          and(
            eq(registrationIntents.scanId, supabaseScanId),
            eq(registrationIntents.emailLookupHash, emailLookupHash),
            isNull(registrationIntents.consumedAt),
          ),
        )
    )[0]!;
    expect(intent.callbackStateHash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(intent)).not.toContain("+14155550123");
    expect(JSON.stringify(intent)).not.toContain(partnerClickId);

    await expect(
      createScannerRegistrationIntent(
        scan,
        {
          email: supabaseEmail,
          phone: "+14155550123",
          role: "business_owner",
          site_is_mine: true,
          marketing_email_opt_in: false,
          dataset_reuse_acknowledged: true,
        },
        {
          partnerClickId,
          sendMagicLink: async () => {
            throw new Error("provider_down");
          },
        },
      ),
    ).rejects.toThrow("scanner_auth_email_unavailable");
    expect(
      (
        await db
          .select()
          .from(registrationIntents)
          .where(
            and(
              eq(registrationIntents.scanId, supabaseScanId),
              eq(registrationIntents.emailLookupHash, emailLookupHash),
              isNull(registrationIntents.consumedAt),
            ),
          )
      )[0]?.callbackStateHash,
    ).toBe(intent.callbackStateHash);
    await expect(
      finalizeScannerRegistration(state!, {
        id: "550e8400-e29b-41d4-a716-446655440001",
        email: "wrong@example.com",
      }),
    ).resolves.toBeUndefined();

    await db.insert(scannerAuthUsers).values({
      id: "550e8400-e29b-41d4-a716-446655440000",
      email: supabaseEmail,
      emailVerified: false,
      name: "",
    });
    await expect(
      finalizeScannerRegistration(state!, {
        id: "550e8400-e29b-41d4-a716-446655440000",
        email: supabaseEmail,
      }),
    ).resolves.toBeUndefined();
    await db
      .update(scannerAuthUsers)
      .set({ emailVerified: true })
      .where(eq(scannerAuthUsers.id, "550e8400-e29b-41d4-a716-446655440000"));
    const finalized = await finalizeScannerRegistration(state!, {
      id: "550e8400-e29b-41d4-a716-446655440000",
      email: supabaseEmail,
    });
    expect(finalized?.scanId).toBe(supabaseScanId);
    const unauthorizedContact = await getContactAccess(
      new NextRequest(
        `http://localhost:3000/api/v2/scans/${supabaseScanId}/contact-access`,
      ),
      { params: Promise.resolve({ id: supabaseScanId }) },
    );
    expect(unauthorizedContact.status).toBe(401);
    const authorizedCookie = `${REPORT_SESSION_COOKIE}=${finalized!.sessionToken}`;
    const authorizedContact = await getContactAccess(
      new NextRequest(
        `http://localhost:3000/api/v2/scans/${supabaseScanId}/contact-access`,
        { headers: { cookie: authorizedCookie } },
      ),
      { params: Promise.resolve({ id: supabaseScanId }) },
    );
    expect(authorizedContact.status).toBe(200);
    const scanTokenPrompt = await getTeaserPrompt(
      new NextRequest(
        `http://localhost:3000/api/v1/scans/${supabaseScanId}/remediation-prompt?scope=teaser`,
        { headers: { authorization: `Bearer ${supabaseScanAccessToken}` } },
      ),
      { params: Promise.resolve({ id: supabaseScanId }) },
    );
    expect(scanTokenPrompt.status).toBe(401);
    const verifiedPrompt = await getTeaserPrompt(
      new NextRequest(
        `http://localhost:3000/api/v1/scans/${supabaseScanId}/remediation-prompt?scope=teaser`,
        { headers: { cookie: authorizedCookie } },
      ),
      { params: Promise.resolve({ id: supabaseScanId }) },
    );
    expect(verifiedPrompt.status).toBe(200);
    const verifiedDownload = await downloadTeaserPrompt(
      new NextRequest(
        `http://localhost:3000/api/v1/scans/${supabaseScanId}/remediation-prompt/download`,
        { headers: { cookie: authorizedCookie } },
      ),
      { params: Promise.resolve({ id: supabaseScanId }) },
    );
    expect(verifiedDownload.status).toBe(200);
    expect(verifiedDownload.headers.get("content-type")).toBe(
      "text/markdown; charset=utf-8",
    );
    expect(verifiedDownload.headers.get("content-disposition")).toBe(
      'attachment; filename="agentify-visible-findings-prompt.md"',
    );
    expect(await verifiedDownload.text()).toContain(
      "# Agentify remediation implementation prompt",
    );
    const lead = (
      await db
        .select()
        .from(leads)
        .where(eq(leads.emailLookupHash, emailLookupHash))
    )[0]!;
    expect(lead.scannerAuthUserId).toBe("550e8400-e29b-41d4-a716-446655440000");
    expect(lead.phoneE164Ciphertext).not.toContain("+14155550123");
    expect(lead.phoneLookupHash).toMatch(/^[a-f0-9]{64}$/);
    const partnerRows = await db
      .select()
      .from(deliveryOutbox)
      .where(eq(deliveryOutbox.destination, "partner_tracker"));
    expect(partnerRows).toHaveLength(1);
    expect(partnerRows[0]?.payload).toEqual({
      clickid: partnerClickId,
      event: "reg",
    });
    expect(
      await finalizeScannerRegistration(state!, {
        id: "550e8400-e29b-41d4-a716-446655440000",
        email: supabaseEmail,
      }),
    ).toBeUndefined();

    let repeatRedirectUrl = "";
    await createScannerRegistrationIntent(
      scan,
      {
        email: supabaseEmail,
        phone: "+14155550123",
        role: "business_owner",
        site_is_mine: true,
        marketing_email_opt_in: false,
        dataset_reuse_acknowledged: true,
      },
      {
        partnerClickId,
        sendMagicLink: async (_email, redirect) => {
          repeatRedirectUrl = redirect;
        },
      },
    );
    await expect(
      finalizeScannerRegistration(
        new URL(repeatRedirectUrl).searchParams.get("state")!,
        {
          id: "550e8400-e29b-41d4-a716-446655440000",
          email: supabaseEmail,
        },
      ),
    ).resolves.toMatchObject({ scanId: supabaseScanId });
    expect(
      await db
        .select()
        .from(deliveryOutbox)
        .where(eq(deliveryOutbox.destination, "partner_tracker")),
    ).toHaveLength(1);

    let revokedRedirectUrl = "";
    const revokedEmail = "revoked-partner@example.com";
    await createScannerRegistrationIntent(
      scan,
      {
        email: revokedEmail,
        phone: "+14155550125",
        role: "developer",
        site_is_mine: false,
        marketing_email_opt_in: false,
        dataset_reuse_acknowledged: true,
      },
      {
        partnerClickId,
        sendMagicLink: async (_email, redirect) => {
          revokedRedirectUrl = redirect;
        },
      },
    );
    const revokedConsentId = createUuidV7();
    await db.insert(consentSnapshots).values({
      id: revokedConsentId,
      sessionId: scan.sessionId,
      policyVersion: "consent-v1.0.0",
      categories: {
        essential_processing: true,
        product_analytics: false,
        ads_measurement: false,
        marketing_email: false,
        dataset_reuse: false,
        card_signal: false,
      },
      source: "test_withdrawal",
    });
    await db
      .update(sessions)
      .set({ consentSnapshotId: revokedConsentId })
      .where(eq(sessions.id, scan.sessionId));
    await db.insert(scannerAuthUsers).values({
      id: "550e8400-e29b-41d4-a716-446655440003",
      email: revokedEmail,
      emailVerified: true,
      name: "",
    });
    await expect(
      finalizeScannerRegistration(
        new URL(revokedRedirectUrl).searchParams.get("state")!,
        {
          id: "550e8400-e29b-41d4-a716-446655440003",
          email: revokedEmail,
        },
      ),
    ).resolves.toMatchObject({ scanId: supabaseScanId });
    expect(
      await db
        .select()
        .from(deliveryOutbox)
        .where(eq(deliveryOutbox.destination, "partner_tracker")),
    ).toHaveLength(1);

    let expiredRedirectUrl = "";
    const expiredEmail = "expired-supabase@example.com";
    await createScannerRegistrationIntent(
      scan,
      {
        email: expiredEmail,
        phone: "+14155550124",
        role: "developer",
        site_is_mine: false,
        marketing_email_opt_in: false,
        dataset_reuse_acknowledged: true,
      },
      {
        sendMagicLink: async (_email, redirect) => {
          expiredRedirectUrl = redirect;
        },
      },
    );
    const expiredState = new URL(expiredRedirectUrl).searchParams.get("state")!;
    await db
      .update(registrationIntents)
      .set({ expiresAt: new Date(Date.now() - 1_000) })
      .where(eq(registrationIntents.callbackStateHash, sha256(expiredState)));
    await expect(
      finalizeScannerRegistration(expiredState, {
        id: "550e8400-e29b-41d4-a716-446655440002",
        email: expiredEmail,
      }),
    ).resolves.toBeUndefined();
  });

  it("verifies once, authorizes 18-row report, saves waitlist and revocable safe share", async () => {
    const evidenceUrl = getLocalEmailEvidence()?.evidenceUrl;
    expect(evidenceUrl).toBeTruthy();
    const token = new URL(evidenceUrl!).searchParams.get("token")!;
    expect(await getFullReport(scanId, undefined)).toBeUndefined();
    const failedReportEmail = async () => false;
    const verified = await verifyEmailToken(token, failedReportEmail);
    expect(verified.status).toBe("verified");
    if (verified.status !== "verified") throw new Error("verification_failed");
    expect((await verifyEmailToken(token)).status).toBe("expired_or_used");
    const report = await getFullReport(scanId, verified.sessionToken);
    expect(report?.checks).toHaveLength(18);
    expect(JSON.stringify(report)).not.toContain("private.example");
    expect(report?.benchmark).toBeNull();
    const fullDownload = await downloadFullPrompt(
      new NextRequest(
        `http://localhost:3000/api/v1/reports/${scanId}/remediation-prompt/download`,
        {
          headers: {
            cookie: `${REPORT_SESSION_COOKIE}=${verified.sessionToken}`,
          },
        },
      ),
      { params: Promise.resolve({ scanId }) },
    );
    expect(fullDownload.status).toBe(200);
    expect(fullDownload.headers.get("content-type")).toBe(
      "text/markdown; charset=utf-8",
    );
    expect(fullDownload.headers.get("content-disposition")).toBe(
      'attachment; filename="agentify-complete-implementation-prompt.md"',
    );
    expect(await fullDownload.text()).toContain(
      "# Agentify remediation implementation prompt",
    );
    const verifiedView = await persistClientEvent(
      new NextRequest("http://localhost:3000/api/v1/events", {
        method: "POST",
        headers: {
          origin: "http://localhost:3000",
          cookie: `${REPORT_SESSION_COOKIE}=${verified.sessionToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          event_id: createUuidV7(),
          name: "results_viewed",
          scan_id: scanId,
          properties: {},
        }),
      }),
    );
    expect(await verifiedView.json()).toMatchObject({
      status: "already_recorded",
    });
    expect(
      await saveWaitlistAnswer(
        report!.waitlist.entry_id,
        "A clear implementation priority list.",
        verified.sessionToken,
      ),
    ).toBe(true);
    expect((await getDatabase().db.select().from(scanShares)).length).toBe(0);
    const unauthorizedPreview = await previewShare(
      new NextRequest(
        `http://localhost:3000/api/v1/scans/${scanId}/share-preview`,
      ),
      { params: Promise.resolve({ id: scanId }) },
    );
    expect(unauthorizedPreview.status).toBe(404);
    const previewResponse = await previewShare(
      new NextRequest(
        `http://localhost:3000/api/v1/scans/${scanId}/share-preview`,
        {
          headers: { authorization: `Bearer ${scanAccessToken}` },
        },
      ),
      { params: Promise.resolve({ id: scanId }) },
    );
    expect(previewResponse.status).toBe(200);
    expect(await previewResponse.json()).toEqual({
      host: "example.com",
      score: 72,
      level: "ahead_of_market",
      rubric_version: "gtm-v1.0.0",
      generated_at: expect.any(String),
      existing_share: null,
    });
    expect((await getDatabase().db.select().from(scanShares)).length).toBe(0);
    const leadId = (
      await getDatabase()
        .db.select({ leadId: leadScans.leadId })
        .from(leadScans)
        .where(eq(leadScans.scanId, scanId))
        .limit(1)
    )[0]!.leadId;
    process.env.PUBLIC_SHARE_ENABLED = "false";
    expect(
      await createPublicShare(
        scanId,
        { verifiedLeadId: leadId, scanTokenAuthorized: false },
        false,
      ),
    ).toBeUndefined();
    expect((await getDatabase().db.select().from(scanShares)).length).toBe(0);
    process.env.PUBLIC_SHARE_ENABLED = "true";
    const shared = await createPublicShare(
      scanId,
      { verifiedLeadId: leadId, scanTokenAuthorized: false },
      false,
    );
    expect(shared && !shared.conflict).toBe(true);
    if (!shared || shared.conflict) throw new Error("share_failed");
    const publishedPreview = await previewShare(
      new NextRequest(
        `http://localhost:3000/api/v1/scans/${scanId}/share-preview`,
        {
          headers: { authorization: `Bearer ${scanAccessToken}` },
        },
      ),
      { params: Promise.resolve({ id: scanId }) },
    );
    expect(await publishedPreview.json()).toMatchObject({
      existing_share: {
        slug: shared.slug,
        public_url: `http://localhost:3000/s/${shared.slug}`,
        status: "published",
      },
    });
    const publicRow = await getPublicShare(shared.slug);
    expect(publicRow?.snapshot).toEqual({
      host: "example.com",
      score: 72,
      level: "ahead_of_market",
      rubric_version: "gtm-v1.0.0",
      generated_at: expect.any(String),
    });
    expect(
      await revokePublicShare(shared.slug, {
        verifiedLeadId: leadId,
        scanTokenAuthorized: false,
      }),
    ).toBe("revoked");
    expect(await getPublicShare(shared.slug)).toBeUndefined();
    const revokedPreview = await previewShare(
      new NextRequest(
        `http://localhost:3000/api/v1/scans/${scanId}/share-preview`,
        {
          headers: { authorization: `Bearer ${scanAccessToken}` },
        },
      ),
      { params: Promise.resolve({ id: scanId }) },
    );
    expect(await revokedPreview.json()).toMatchObject({
      existing_share: null,
    });
    const eventCounts = await getDatabase().pool.query<{
      name: string;
      count: string;
      once_count: string;
    }>(
      `select name, count(*)::text as count, count(once_key)::text as once_count
       from analytics_events
       where scan_id = $1 and name in ('registration_completed', 'waitlist_question_answered', 'result_shared')
       group by name order by name`,
      [scanId],
    );
    expect(eventCounts.rows).toEqual([
      { name: "registration_completed", count: "1", once_count: "1" },
      { name: "result_shared", count: "1", once_count: "1" },
      { name: "waitlist_question_answered", count: "1", once_count: "1" },
    ]);
    expect(
      await getDatabase().pool.query<{ count: string }>(
        "select count(*)::text as count from analytics_events where scan_id = $1 and name = 'results_viewed'",
        [scanId],
      ),
    ).toMatchObject({ rows: [{ count: "1" }] });

    await getDatabase()
      .db.update(scans)
      .set({ accessTokenExpiresAt: new Date(Date.now() - 1_000) })
      .where(eq(scans.id, scanId));
    expect(await authorizeScan(scanId, scanAccessToken)).toBeUndefined();
    const expiredShare = await publishShare(
      new NextRequest(`http://localhost:3000/api/v1/scans/${scanId}/share`, {
        method: "POST",
        headers: {
          origin: "http://localhost:3000",
          authorization: `Bearer ${scanAccessToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ allow_indexing: false }),
      }),
      { params: Promise.resolve({ id: scanId }) },
    );
    expect(expiredShare.status).toBe(404);
  });

  it("atomically persists queue state/job and never requeues terminal replay", async () => {
    const body = {
      url: "https://queue-atomic.example/",
      segment: "owner" as const,
      landing_variant: "owner-v1",
      turnstile_token: null,
    };
    const stableKey = `queue-atomic-${createUuidV7()}`;
    const first = await createOrReplayScan(body, stableKey, undefined);
    expect(first.anonymousToken).toBeTruthy();
    const stored = (
      await getDatabase()
        .db.select()
        .from(scans)
        .where(eq(scans.id, first.scanId))
        .limit(1)
    )[0]!;
    expect(stored.status).toBe("queued");
    const jobCount = async (id: string) =>
      (
        await getDatabase().pool.query<{ count: string }>(
          "select count(*)::text as count from pgboss.job where data->>'scan_id' = $1",
          [id],
        )
      ).rows[0]?.count;
    expect(await jobCount(first.scanId)).toBe("1");
    const stableReplay = await createOrReplayScan(
      body,
      stableKey,
      first.anonymousToken,
    );
    expect(stableReplay.scanId).toBe(first.scanId);
    expect(await jobCount(first.scanId)).toBe("1");
    expect(
      (await createOrReplayScan(body, stableKey, first.anonymousToken, true))
        .conflict,
    ).toBe(true);
    await getDatabase()
      .db.update(scans)
      .set({
        status: "completed",
        score: 80,
        coverage: "1.000",
        level: "ahead_of_market",
        applicableWeight: "100",
        earnedWeight: "80",
        finishedAt: new Date(),
      })
      .where(eq(scans.id, first.scanId));
    await createOrReplayScan(body, stableKey, first.anonymousToken);
    expect(
      (
        await getDatabase()
          .db.select({ status: scans.status })
          .from(scans)
          .where(eq(scans.id, first.scanId))
          .limit(1)
      )[0]?.status,
    ).toBe("completed");
    expect(await jobCount(first.scanId)).toBe("1");

    const rollbackScanId = createUuidV7();
    await getDatabase()
      .db.insert(scans)
      .values({
        id: rollbackScanId,
        sessionId: stored.sessionId,
        segment: "owner",
        rubricVersion: "gtm-v1.0.0",
        submittedUrlRedacted: "https://rollback.example/",
        canonicalTargetUrl: "https://rollback.example/",
        targetHost: "rollback.example",
        targetHash: `target-${rollbackScanId}`,
        accessTokenHash: `token-${rollbackScanId}`,
        accessTokenExpiresAt: new Date(Date.now() + 86_400_000),
        idempotencyKeyHash: `idem-${rollbackScanId}`,
        idempotencyBodyHash: `body-${rollbackScanId}`,
      });
    await expect(
      getDatabase().db.transaction(async (tx) => {
        await enqueueScanInTransaction(tx, {
          scanId: rollbackScanId,
          canonicalTargetUrl: "https://rollback.example/",
          submittedWithoutScheme: false,
          segment: "owner",
        });
        throw new Error("force_queue_transaction_rollback");
      }),
    ).rejects.toThrow("force_queue_transaction_rollback");
    expect(
      (
        await getDatabase()
          .db.select({ status: scans.status })
          .from(scans)
          .where(eq(scans.id, rollbackScanId))
          .limit(1)
      )[0]?.status,
    ).toBe("accepted");
    expect(await jobCount(rollbackScanId)).toBe("0");
    await getDatabase().pool.query(
      "delete from pgboss.job where data->>'scan_id' = any($1::text[])",
      [[first.scanId, rollbackScanId]],
    );
  });

  it("atomically gates the fourth scan and commits both buckets together", async () => {
    const suffix = createUuidV7();
    const ipKey = `rate-ip-${suffix}`;
    const targetKey = `rate-target-${suffix}`;
    const initial = await Promise.all(
      Array.from({ length: 5 }, () =>
        consumeScanRateLimits({ ipKey, targetKey, challengePassed: false }),
      ),
    );
    expect(initial.filter((result) => result === "allowed")).toHaveLength(3);
    expect(
      initial.filter((result) => result === "challenge_required"),
    ).toHaveLength(2);
    expect(await readRateCount(ipKey, "scan_ip_hour")).toBe(3);
    expect(await readRateCount(targetKey, "scan_target_day")).toBe(3);

    const challenged = await Promise.all(
      Array.from({ length: 7 }, () =>
        consumeScanRateLimits({ ipKey, targetKey, challengePassed: true }),
      ),
    );
    expect(challenged.every((result) => result === "allowed")).toBe(true);
    const untouchedTarget = `rate-untouched-${suffix}`;
    expect(
      await consumeScanRateLimits({
        ipKey,
        targetKey: untouchedTarget,
        challengePassed: true,
      }),
    ).toBe("hard_rate_limit");
    expect(await readRateCount(untouchedTarget, "scan_target_day")).toBe(0);
  });

  it("keeps the IP-hour threshold rolling across a UTC hour boundary", async () => {
    const suffix = createUuidV7();
    const ipKey = `rolling-ip-${suffix}`;
    const targetKey = `rolling-target-${suffix}`;
    const beforeBoundary = new Date("2026-07-12T00:59:59.000Z");
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await expect(
        consumeScanRateLimits({
          ipKey,
          targetKey,
          challengePassed: false,
          now: beforeBoundary,
        }),
      ).resolves.toBe("allowed");
    }
    const afterBoundary = new Date("2026-07-12T01:00:01.000Z");
    await expect(
      consumeScanRateLimits({
        ipKey,
        targetKey,
        challengePassed: false,
        now: afterBoundary,
      }),
    ).resolves.toBe("challenge_required");
    expect(await readRateCount(ipKey, "scan_ip_hour", afterBoundary)).toBe(3);

    const afterRollingExpiry = new Date("2026-07-12T02:00:00.001Z");
    await expect(
      consumeScanRateLimits({
        ipKey,
        targetKey,
        challengePassed: false,
        now: afterRollingExpiry,
      }),
    ).resolves.toBe("allowed");
    expect(await readRateCount(ipKey, "scan_ip_hour", afterRollingExpiry)).toBe(
      1,
    );
  });
  it("spends a scanner mail link once and refuses a mismatched or cross-site confirmation", async () => {
    const { db } = getDatabase();
    const { scan } = await createFreshCompletedScan("magic-link");
    const requestLink = async (email: string) => {
      await createScannerRegistrationIntent(scan, {
        email,
        phone: "+14155550130",
        role: "business_owner",
        site_is_mine: true,
        marketing_email_opt_in: false,
        dataset_reuse_acknowledged: true,
      });
      const url = new URL(getLocalEmailEvidence()?.evidenceUrl ?? "");
      const fragment = new URLSearchParams(url.hash.slice(1));
      return { state: fragment.get("state")!, token: fragment.get("token")! };
    };
    const first = await requestLink("scanner-live@example.com");
    const second = await requestLink("scanner-mismatch@example.com");
    expect(first.state).toHaveLength(43);
    expect(first.token).toHaveLength(32);
    expect(
      await db
        .select()
        .from(leads)
        .where(
          eq(
            leads.emailLookupHash,
            hmacHex(
              process.env.TOKEN_HMAC_SECRET!,
              "email",
              "scanner-live@example.com",
            ),
          ),
        ),
    ).toHaveLength(0);

    const post = (body: unknown, origin = "http://localhost:3000") =>
      finalizeScannerAuth(
        new NextRequest("http://localhost:3000/api/v2/auth/finalize", {
          method: "POST",
          headers: { origin, "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
      );
    expect((await post(first, "https://foreign.example")).status).toBe(403);
    expect(
      (await post({ state: second.state, token: first.token })).status,
    ).toBe(401);
    const [winner, replay] = await Promise.all([post(first), post(first)]);
    expect([winner.status, replay.status].sort()).toEqual([200, 401]);
    const successful = winner.status === 200 ? winner : replay;
    expect(successful.headers.get("set-cookie")).toContain(
      REPORT_SESSION_COOKIE,
    );
    expect(successful.headers.get("set-cookie")).not.toContain("scanner-auth");
    expect((await post(first)).status).toBe(401);
    const linked = (
      await db
        .select()
        .from(leads)
        .where(
          eq(
            leads.emailLookupHash,
            hmacHex(
              process.env.TOKEN_HMAC_SECRET!,
              "email",
              "scanner-live@example.com",
            ),
          ),
        )
    )[0]!;
    expect(linked.verifiedAt).toBeInstanceOf(Date);
    expect(linked.scannerAuthUserId).toBeTruthy();
    expect(
      await db
        .select()
        .from(scannerAuthSessions)
        .where(eq(scannerAuthSessions.userId, linked.scannerAuthUserId!)),
    ).toHaveLength(0);

    const expiring = await requestLink("scanner-expired@example.com");
    await db
      .update(registrationIntents)
      .set({ expiresAt: new Date(Date.now() - 1_000) })
      .where(eq(registrationIntents.callbackStateHash, sha256(expiring.state)));
    expect((await post(expiring)).status).toBe(401);
  });

  it("keeps the verification usable when report-session creation fails", async () => {
    const { db } = getDatabase();
    const { scan } = await createFreshCompletedScan("rollback");
    const email = "scanner-rollback@example.com";
    await createScannerRegistrationIntent(scan, {
      email,
      phone: "+14155550131",
      role: "developer",
      site_is_mine: false,
      marketing_email_opt_in: false,
      dataset_reuse_acknowledged: true,
    });
    const fragment = new URLSearchParams(
      new URL(getLocalEmailEvidence()!.evidenceUrl!).hash.slice(1),
    );
    const body = { state: fragment.get("state"), token: fragment.get("token") };
    const post = () =>
      finalizeScannerAuth(
        new NextRequest("http://localhost:3000/api/v2/auth/finalize", {
          method: "POST",
          headers: {
            origin: "http://localhost:3000",
            "content-type": "application/json",
          },
          body: JSON.stringify(body),
        }),
      );
    const beforeVerification = await db.select().from(scannerAuthVerifications);
    await admin.pool
      .query(`create function fail_scanner_report_session() returns trigger
      language plpgsql as $$ begin raise exception 'forced_report_failure'; end $$`);
    await admin.pool
      .query(`create trigger fail_scanner_report_session before insert on report_sessions
      for each row execute function fail_scanner_report_session()`);
    try {
      expect((await post()).status).toBe(503);
      expect(await db.select().from(scannerAuthVerifications)).toEqual(
        beforeVerification,
      );
      expect(
        await db
          .select()
          .from(scannerAuthUsers)
          .where(eq(scannerAuthUsers.email, email)),
      ).toHaveLength(0);
      expect(
        await db
          .select()
          .from(leads)
          .where(
            eq(
              leads.emailLookupHash,
              hmacHex(process.env.TOKEN_HMAC_SECRET!, "email", email),
            ),
          ),
      ).toHaveLength(0);
    } finally {
      await admin.pool.query(
        "drop trigger fail_scanner_report_session on report_sessions",
      );
      await admin.pool.query("drop function fail_scanner_report_session()");
    }
    expect((await post()).status).toBe(200);
    expect((await post()).status).toBe(401);
  });

  it("converges two distinct valid links for one email on one identity and lead", async () => {
    const { db } = getDatabase();
    const email = "scanner-concurrent@example.com";
    const linkBodies: { state: string | null; token: string | null }[] = [];
    const scanIds: string[] = [];
    for (let index = 0; index < 2; index++) {
      const { scan } = await createFreshCompletedScan(`concurrent-${index}`);
      scanIds.push(scan.id);
      await createScannerRegistrationIntent(scan, {
        email,
        phone: "+14155550132",
        role: "business_owner",
        site_is_mine: true,
        marketing_email_opt_in: false,
        dataset_reuse_acknowledged: true,
      });
      const fragment = new URLSearchParams(
        new URL(getLocalEmailEvidence()!.evidenceUrl!).hash.slice(1),
      );
      linkBodies.push({
        state: fragment.get("state"),
        token: fragment.get("token"),
      });
    }
    const responses = await Promise.all(
      linkBodies.map((body) =>
        finalizeScannerAuth(
          new NextRequest("http://localhost:3000/api/v2/auth/finalize", {
            method: "POST",
            headers: {
              origin: "http://localhost:3000",
              "content-type": "application/json",
            },
            body: JSON.stringify(body),
          }),
        ),
      ),
    );
    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    const users = await db
      .select()
      .from(scannerAuthUsers)
      .where(eq(scannerAuthUsers.email, email));
    expect(users).toHaveLength(1);
    const lead = (
      await db
        .select()
        .from(leads)
        .where(
          eq(
            leads.emailLookupHash,
            hmacHex(process.env.TOKEN_HMAC_SECRET!, "email", email),
          ),
        )
    )[0]!;
    expect(lead.scannerAuthUserId).toBe(users[0]!.id);
    expect(
      (await db.select().from(leadScans).where(eq(leadScans.leadId, lead.id)))
        .map((row) => row.scanId)
        .sort(),
    ).toEqual(scanIds.sort());
    expect(
      await db
        .select()
        .from(reportSessions)
        .where(eq(reportSessions.leadId, lead.id)),
    ).toHaveLength(2);
  });

  it("does not revive an anonymized scan when a request was already sending a link", async () => {
    const { db } = getDatabase();
    const { scan: original } = await createFreshCompletedScan("deletion-race");
    const email = "scanner-deletion-race@example.com";
    const config = getServerConfig();
    const leadId = createUuidV7();
    await db.insert(leads).values({
      id: leadId,
      emailNormalizedCiphertext: encryptEmail(email, config.encryptionKey),
      emailLookupHash: hmacHex(config.hmacSecret, "email", email),
      role: "developer",
      firstSegment: "owner",
      firstSessionId: original.sessionId,
    });
    await db.update(scans).set({ leadId }).where(eq(scans.id, original.id));
    const scan = (
      await db.select().from(scans).where(eq(scans.id, original.id))
    )[0]!;
    await createScannerRegistrationIntent(scan, {
      email,
      phone: "+14155550134",
      role: "developer",
      site_is_mine: false,
      marketing_email_opt_in: false,
      dataset_reuse_acknowledged: true,
    });
    const firstFragment = new URLSearchParams(
      new URL(getLocalEmailEvidence()!.evidenceUrl!).hash.slice(1),
    );
    let markSending!: () => void;
    let releaseSending!: () => void;
    const sending = new Promise<void>((resolve) => {
      markSending = resolve;
    });
    const continueSending = new Promise<void>((resolve) => {
      releaseSending = resolve;
    });
    const lateRequest = createScannerRegistrationIntent(
      scan,
      {
        email,
        phone: "+14155550134",
        role: "developer",
        site_is_mine: false,
        marketing_email_opt_in: false,
        dataset_reuse_acknowledged: true,
      },
      {
        sendMagicLink: async () => {
          markSending();
          await continueSending;
        },
      },
    );
    await sending;
    await expect(completeLeadDeletion({ leadId })).resolves.toMatchObject({
      database: { status: "anonymized" },
    });
    releaseSending();
    await expect(lateRequest).rejects.toThrow("registration_scan_unavailable");
    const response = await finalizeScannerAuth(
      new NextRequest("http://localhost:3000/api/v2/auth/finalize", {
        method: "POST",
        headers: {
          origin: "http://localhost:3000",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          state: firstFragment.get("state"),
          token: firstFragment.get("token"),
        }),
      }),
    );
    expect(response.status).toBe(401);
    expect(
      (await db.select().from(scans).where(eq(scans.id, scan.id)))[0]?.leadId,
    ).toBeNull();
    expect(
      (await db.select().from(leads).where(eq(leads.id, leadId)))[0]?.role,
    ).toBe("deleted");
  });

  it("keeps an admitted link valid when its scan bearer expires during email delivery", async () => {
    const { db } = getDatabase();
    const { scan } = await createFreshCompletedScan("bearer-expiry");
    const email = "scanner-bearer-expiry@example.com";
    const result = await createScannerRegistrationIntent(
      scan,
      {
        email,
        phone: "+14155550135",
        role: "developer",
        site_is_mine: false,
        marketing_email_opt_in: false,
        dataset_reuse_acknowledged: true,
      },
      {
        sendMagicLink: async (address, redirect) => {
          await sendScannerMagicLink(
            address,
            new URL(redirect).searchParams.get("state")!,
          );
          await db
            .update(scans)
            .set({
              accessTokenExpiresAt: new Date(Date.now() - 1_000),
            })
            .where(eq(scans.id, scan.id));
        },
      },
    );
    expect(result.sent).toBe(true);
    const fragment = new URLSearchParams(
      new URL(getLocalEmailEvidence()!.evidenceUrl!).hash.slice(1),
    );
    const response = await finalizeScannerAuth(
      new NextRequest("http://localhost:3000/api/v2/auth/finalize", {
        method: "POST",
        headers: {
          origin: "http://localhost:3000",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          state: fragment.get("state"),
          token: fragment.get("token"),
        }),
      }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toContain(REPORT_SESSION_COOKIE);
  });

  it("serializes cross-email confirmation with deletion of the scan's old owner", async () => {
    const { db, pool } = getDatabase();
    const { scan: original } =
      await createFreshCompletedScan("cross-email-delete");
    const oldEmail = "scanner-old-owner@example.com";
    const newEmail = "scanner-new-owner@example.com";
    const config = getServerConfig();
    const oldLeadId = createUuidV7();
    await db.insert(leads).values({
      id: oldLeadId,
      emailNormalizedCiphertext: encryptEmail(oldEmail, config.encryptionKey),
      emailLookupHash: hmacHex(config.hmacSecret, "email", oldEmail),
      role: "developer",
      firstSegment: "owner",
      firstSessionId: original.sessionId,
    });
    await db
      .update(scans)
      .set({ leadId: oldLeadId })
      .where(eq(scans.id, original.id));
    const scan = (
      await db.select().from(scans).where(eq(scans.id, original.id))
    )[0]!;
    await createScannerRegistrationIntent(scan, {
      email: newEmail,
      phone: "+14155550136",
      role: "developer",
      site_is_mine: false,
      marketing_email_opt_in: false,
      dataset_reuse_acknowledged: true,
    });
    const fragment = new URLSearchParams(
      new URL(getLocalEmailEvidence()!.evidenceUrl!).hash.slice(1),
    );
    await admin.pool
      .query(`create function hold_scanner_consume() returns trigger
      language plpgsql as $$ begin perform pg_advisory_xact_lock(479925); return old; end $$`);
    await admin.pool.query(`create trigger hold_scanner_consume before delete
      on scanner_auth_verifications for each row
      when ((old.value::jsonb ->> 'email') = 'scanner-new-owner@example.com')
      execute function hold_scanner_consume()`);
    const blocker = await admin.pool.connect();
    await blocker.query("begin");
    await blocker.query("select pg_advisory_xact_lock(479925)");
    let confirm: Promise<Response> | undefined;
    let deletion: ReturnType<typeof completeLeadDeletion> | undefined;
    try {
      confirm = finalizeScannerAuth(
        new NextRequest("http://localhost:3000/api/v2/auth/finalize", {
          method: "POST",
          headers: {
            origin: "http://localhost:3000",
            "content-type": "application/json",
          },
          body: JSON.stringify({
            state: fragment.get("state"),
            token: fragment.get("token"),
          }),
        }),
      );
      let consumeBlocked = false;
      for (let attempt = 0; attempt < 30; attempt++) {
        const state = await pool.query<{ count: number }>(
          `select count(*)::int as count from pg_stat_activity
           where datname = current_database() and wait_event_type = 'Lock'
             and query like '%scanner_auth_verifications%'`,
        );
        if ((state.rows[0]?.count ?? 0) > 0) {
          consumeBlocked = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(consumeBlocked).toBe(true);
      deletion = completeLeadDeletion({ leadId: oldLeadId });
      const deletionFinishedBeforeRelease = await Promise.race([
        deletion.then(() => true),
        new Promise<false>((resolve) => setTimeout(() => resolve(false), 150)),
      ]);
      expect(deletionFinishedBeforeRelease).toBe(false);
    } finally {
      await blocker.query("commit");
      blocker.release();
      await Promise.allSettled([confirm, deletion]);
      await admin.pool.query(
        "drop trigger hold_scanner_consume on scanner_auth_verifications",
      );
      await admin.pool.query("drop function hold_scanner_consume()");
    }
    expect((await confirm!).status).toBe(200);
    await expect(deletion!).resolves.toMatchObject({
      database: { status: "anonymized" },
    });
    const after = (
      await db.select().from(scans).where(eq(scans.id, scan.id))
    )[0]!;
    expect(after.leadId).toBeNull();
    expect(after.sessionId).not.toBe(scan.sessionId);
    expect(after.submittedUrlRedacted).toBe("redacted://deleted");
  });

  it("reports a registration limit instead of claiming that email was sent", async () => {
    const { scan, accessToken } = await createFreshCompletedScan("rate-limit");
    const email = "scanner-rate-limit@example.com";
    const body = {
      email,
      phone: "+14155550133",
      role: "developer",
      site_is_mine: false,
      marketing_email_opt_in: false,
      dataset_reuse_acknowledged: true,
    } as const;
    for (let index = 0; index < 3; index++)
      expect((await createScannerRegistrationIntent(scan, body)).sent).toBe(
        true,
      );
    process.env.REGISTRATION_ENABLED = "true";
    try {
      const response = await requestScannerRegistration(
        new NextRequest(
          `http://localhost:3000/api/v2/scans/${scan.id}/registrations`,
          {
            method: "POST",
            headers: {
              origin: "http://localhost:3000",
              "content-type": "application/json",
              authorization: `Bearer ${accessToken}`,
            },
            body: JSON.stringify(body),
          },
        ),
        { params: Promise.resolve({ id: scan.id }) },
      );
      expect(response.status).toBe(429);
      expect(await response.text()).not.toContain("verification_sent");
    } finally {
      process.env.REGISTRATION_ENABLED = "false";
    }
  });
});
