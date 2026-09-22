import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";

import { CONSENT_POLICY_VERSION } from "@agentify/analytics";
import { CHECK_DEFINITIONS } from "@agentify/scanner-contracts";
import { REPORT_CABINET_HANDOFF_COOKIE } from "@agentify/scanner-contracts/report-cabinet-handoff";
import { reportIdentityTokenHash } from "@agentify/scanner-contracts/report-identity";
import {
  consentSnapshots,
  createDatabase,
  createUuidV7,
  deliveryOutbox,
  leadScans,
  leads,
  migrateDatabase,
  registrationIntents,
  reportSessions,
  scanChecks,
  scannerIdentityCompletions,
  scannerRecoveryIntents,
  scanShares,
  scans,
  sessions,
  waitlistEntries,
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
import { POST as publishShare } from "../../app/api/v1/scans/[id]/share/route";
import { GET as previewShare } from "../../app/api/v1/scans/[id]/share-preview/route";
import { POST as acceptScan } from "../../app/api/v1/scans/route";
import { POST as finalizeScannerAuth } from "../../app/api/v2/auth/finalize/route";
import { handleScannerRecoveryRequest } from "../../app/api/v2/auth/recover/route";
import { GET as getContactAccess } from "../../app/api/v2/scans/[id]/contact-access/route";
import { POST as requestScannerRegistration } from "../../app/api/v2/scans/[id]/registrations/route";
import { REPORT_SESSION_COOKIE } from "./auth";
import { getCabinetReportIdentityClient } from "./cabinet-report-identity";
import { getServerConfig } from "./config";
import { decryptEmail, encryptEmail, hmacHex, sha256 } from "./crypto";
import { getDatabase } from "./database";
import { enqueueScanInTransaction, stopScanQueue } from "./queue";
import { consumeScanRateLimits, readRateCount } from "./rate-limit";
import { createPublicShare, getFullReport, getPublicShare, revokePublicShare } from "./reporting";
import { requestScannerIdentityDeletion } from "./scanner-identity-deletion";
import { verifyAndFinalizeScannerIdentity } from "./scanner-identity-finalize";
import { requestScannerReportRecovery } from "./scanner-recovery";
import { createScannerRegistrationIntent } from "./scanner-registration";
import { authorizeScan, createOrReplayScan } from "./scans";

const connectionString = process.env.MIGRATION_TEST_DATABASE_URL;
if (!connectionString?.includes("_migration_test")) {
  throw new Error("P4 integration requires a dedicated *_migration_test database");
}
process.env.DATABASE_URL = connectionString;
process.env.APP_BASE_URL = "http://localhost:3000";
const tokenHmacSecret = "p4-integration-hmac-secret-with-at-least-32-bytes";
process.env.TOKEN_HMAC_SECRET = tokenHmacSecret;
process.env.EMAIL_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString("base64");
process.env.TURNSTILE_ENFORCED = "false";
process.env.PUBLIC_SHARE_ENABLED = "true";
process.env.REGISTRATION_ENABLED = "false";
process.env.PARTNER_POSTBACK_ENABLED = "true";
process.env.REPORT_IDENTITY_SECRET = "r".repeat(32);
process.env.CABINET_IDENTITY_URL = "http://127.0.0.1:1";

const migrationsFolder = fileURLToPath(
  new URL("../../../../packages/scanner-database/migrations", import.meta.url),
);
const admin = createDatabase(connectionString, { max: 1 });

type LinkRecord = {
  email: string;
  intentKind: "registration" | "recovery";
  state: string;
  token: string;
  tokenHash: string;
  receiptId?: string;
  completionDeadline: Date;
  consumeCount: number;
  acknowledgeCount: number;
  issueCount: number;
  refuseConsume: boolean;
  acknowledgeFailures: number;
};

const links: LinkRecord[] = [];
let tokenSequence = 0;
let cabinetServer: Server;
let scanId = "";
let scanAccessToken = "";
const anonymousToken = "p4-attribution-anonymous-token";

function latestLink(email: string, intentKind: "registration" | "recovery") {
  const record = links.findLast(
    (candidate) => candidate.email === email && candidate.intentKind === intentKind,
  );
  if (!record) throw new Error("cabinet_test_link_missing");
  return record;
}

function respondJson(response: ServerResponse, status: number, body: object) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

async function readJson(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

// A fixture query that must find its row: an empty result is a broken test, and
// it should say so here rather than fail later on a property of undefined.
function onlyRow<T>(rows: readonly T[]): T {
  const [row] = rows;
  if (!row) throw new Error("a query that must return one row returned none");
  return row;
}

async function createCompletedScan(label: string) {
  const { db } = getDatabase();
  const sessionId = createUuidV7();
  const scanId = createUuidV7();
  await db.insert(sessions).values({
    id: sessionId,
    anonymousIdHash: `p4-${label}-${sessionId}`,
    firstLandingVariant: "owner-v1",
  });
  await db.insert(scans).values({
    id: scanId,
    sessionId,
    segment: "owner",
    rubricVersion: "gtm-v1.0.0",
    submittedUrlRedacted: `https://${label}.example/`,
    canonicalTargetUrl: `https://${label}.example/`,
    targetHost: `${label}.example`,
    targetHash: `target-${label}-${scanId}`,
    status: "completed",
    score: 72,
    coverage: "1.000",
    level: "ahead_of_market",
    applicableWeight: "100",
    earnedWeight: "72",
    finishedAt: new Date(),
    accessTokenHash: `access-${label}-${scanId}`,
    accessTokenExpiresAt: new Date(Date.now() + 86_400_000),
    idempotencyKeyHash: `idem-${label}-${scanId}`,
    idempotencyBodyHash: `body-${label}-${scanId}`,
  });
  return onlyRow(await db.select().from(scans).where(eq(scans.id, scanId)));
}

async function createFreshCompletedScan(label: string) {
  const { db } = getDatabase();
  const source = onlyRow(await db.select().from(scans).where(eq(scans.id, scanId)));
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
    targetHash: `fresh-${label}-target-${id}`,
    accessTokenHash: sha256(accessToken),
    accessTokenExpiresAt: new Date(Date.now() + 86_400_000),
    idempotencyKeyHash: `fresh-${label}-idem-${id}`,
    idempotencyBodyHash: `fresh-${label}-body-${id}`,
  });
  return {
    scan: onlyRow(await db.select().from(scans).where(eq(scans.id, id))),
    accessToken,
  };
}

function finalizeRequest(body: unknown, origin = "http://localhost:3000") {
  return finalizeScannerAuth(
    new NextRequest("http://localhost:3000/api/v2/auth/finalize", {
      method: "POST",
      headers: { origin, "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

const registrationBody = (email: string) => ({
  email,
  phone: "+14155550123",
  role: "business_owner",
  site_is_mine: true,
  marketing_email_opt_in: false,
  dataset_reuse_acknowledged: true as const,
});

async function installReportSessionFailureTrigger() {
  await getDatabase().pool.query(`
    drop trigger if exists reject_report_identity_session on report_sessions;
    create or replace function reject_report_identity_session() returns trigger
    language plpgsql as $$ begin raise exception 'forced_report_session_failure'; end $$;
    create trigger reject_report_identity_session
      before insert on report_sessions for each row
      execute function reject_report_identity_session()
  `);
}

async function expectLocalReportSessionFailure(promise: Promise<unknown>) {
  try {
    await promise;
    throw new Error("expected_report_session_failure");
  } catch (error) {
    const cause = (error as { cause?: unknown }).cause;
    expect(cause instanceof Error ? cause.message : String(error)).toMatch(
      /forced_report_session_failure/,
    );
  }
}

async function removeReportSessionFailureTrigger() {
  await getDatabase().pool.query(`
    drop trigger if exists reject_report_identity_session on report_sessions;
    drop function if exists reject_report_identity_session()
  `);
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
    anonymousIdHash: hmacHex(tokenHmacSecret, "anonymous", anonymousToken),
  });
  await db.insert(consentSnapshots).values({
    id: consentId,
    sessionId,
    policyVersion: "phase-a-v1",
    categories: { essential_processing: true },
    source: "test",
  });
  await db.update(sessions).set({ consentSnapshotId: consentId }).where(eq(sessions.id, sessionId));
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
      status: check.id === 8 || check.id === 17 ? ("not_applicable" as const) : ("pass" as const),
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
  cabinetServer = createServer(async (request, response) => {
    if (
      request.url !== "/internal/report-identity" ||
      request.method !== "POST" ||
      request.headers.authorization !== `Bearer ${process.env.REPORT_IDENTITY_SECRET}`
    ) {
      respondJson(response, 404, { error: "not_found" });
      return;
    }
    const body = await readJson(request);
    if (body.operation === "send") {
      tokenSequence += 1;
      const token = tokenSequence.toString().padStart(32, "A");
      const record: LinkRecord = {
        email: String(body.email),
        intentKind: body.intent_kind as LinkRecord["intentKind"],
        state: String(body.state),
        token,
        tokenHash: reportIdentityTokenHash(token),
        completionDeadline: new Date(Date.now() + 5 * 60_000),
        consumeCount: 0,
        acknowledgeCount: 0,
        issueCount: 0,
        refuseConsume: false,
        acknowledgeFailures: 0,
      };
      links.push(record);
      respondJson(response, 200, {
        status: "accepted",
        token_hash: record.tokenHash,
      });
      return;
    }
    if (body.operation === "verify" && body.phase === "consume") {
      const record = links.find(
        (candidate) =>
          candidate.token === body.token &&
          candidate.email === body.email &&
          candidate.intentKind === body.intent_kind &&
          candidate.state === body.state,
      );
      if (!record || record.refuseConsume) {
        respondJson(response, 200, { status: "refused" });
        return;
      }
      record.consumeCount += 1;
      record.receiptId ??= createUuidV7();
      respondJson(response, 200, {
        status: "pending",
        receipt_id: record.receiptId,
        completion_deadline: record.completionDeadline.toISOString(),
      });
      return;
    }
    if (body.operation === "verify" && body.phase === "acknowledge") {
      const record = links.find((candidate) => candidate.receiptId === body.receipt_id);
      if (!record || record.tokenHash !== body.token_hash) {
        respondJson(response, 200, { status: "refused" });
        return;
      }
      record.acknowledgeCount += 1;
      if (record.acknowledgeFailures > 0) {
        record.acknowledgeFailures -= 1;
        respondJson(response, 503, { status: "unavailable" });
        return;
      }
      respondJson(response, 200, { status: "completed" });
      return;
    }
    if (body.operation === "issue") {
      const record = links.find((candidate) => candidate.receiptId === body.receipt_id);
      if (!record || record.tokenHash !== body.token_hash) {
        respondJson(response, 200, { status: "refused" });
        return;
      }
      record.issueCount += 1;
      respondJson(
        response,
        200,
        record.issueCount === 1
          ? {
              status: "issued",
              action_url: `http://localhost:3000/cabinet/sign-in/open?token=${"C".repeat(32)}`,
            }
          : { status: "already_attempted" },
      );
      return;
    }
    if (body.operation === "delete") {
      respondJson(response, 200, { status: "deleted" });
      return;
    }
    respondJson(response, 400, { status: "refused" });
  });
  await new Promise<void>((resolve) => cabinetServer.listen(0, "127.0.0.1", resolve));
  const address = cabinetServer.address();
  if (!address || typeof address === "string") throw new Error("server_address");
  process.env.CABINET_IDENTITY_URL = `http://127.0.0.1:${address.port}`;
}, 30_000);

afterAll(async () => {
  await stopScanQueue();
  await removeReportSessionFailureTrigger().catch(() => undefined);
  await new Promise<void>((resolve, reject) =>
    cabinetServer.close((error) => (error ? reject(error) : resolve())),
  );
  await getDatabase().pool.end();
  await admin.pool.query(
    "drop schema if exists public cascade; drop schema if exists drizzle cascade; create schema public",
  );
  await admin.pool.end();
});

describe("P4 cabinet-owned scanner identity", () => {
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
            "x-agentify-submitted-without-scheme": spoofedHeader,
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
    expect(rows.find(({ id }) => id === explicit.scan_id)?.submittedWithoutScheme).toBe(false);
    expect(rows.find(({ id }) => id === omitted.scan_id)?.submittedWithoutScheme).toBe(true);
  });

  it("keeps attribution neutral and both accepted registration links usable", async () => {
    const { db } = getDatabase();
    const attributionRequest = (campaign: string, fbclidHash: string) =>
      new NextRequest("http://localhost:3000/api/v1/attribution", {
        method: "POST",
        headers: {
          origin: "http://localhost:3000",
          cookie: `agentify_anonymous=${anonymousToken}`,
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
      (await persistAttribution(attributionRequest("first-campaign", "a".repeat(64)))).status,
    ).toBe(204);
    expect(
      (await persistAttribution(attributionRequest("last-campaign", "b".repeat(64)))).status,
    ).toBe(204);
    const attributedSession = onlyRow(
      await db
        .select()
        .from(sessions)
        .where(eq(sessions.anonymousIdHash, hmacHex(tokenHmacSecret, "anonymous", anonymousToken)))
        .limit(1),
    );
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
          cookie: `agentify_anonymous=${anonymousToken}`,
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
      (await persistAttribution(partnerAttributionRequest())).headers.get("set-cookie") ?? "",
    ).not.toContain(`clickid=${partnerClickId}`);
    const consentRequest = (adsMeasurement: boolean) =>
      new NextRequest("http://localhost:3000/api/v1/consent", {
        method: "POST",
        headers: {
          origin: "http://localhost:3000",
          cookie: `agentify_anonymous=${anonymousToken}`,
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
      (await persistAttribution(partnerAttributionRequest())).headers.get("set-cookie"),
    ).toContain(`clickid=${partnerClickId}`);
    const revoked = await persistConsent(consentRequest(false));
    expect(revoked.headers.get("set-cookie")).toMatch(/clickid=;.*Max-Age=0/i);
    const piiAttribution = await persistAttribution(
      new NextRequest("http://localhost:3000/api/v1/attribution", {
        method: "POST",
        headers: {
          origin: "http://localhost:3000",
          cookie: `agentify_anonymous=${anonymousToken}`,
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

    const scan = onlyRow(await db.select().from(scans).where(eq(scans.id, scanId)).limit(1));
    const body = registrationBody("Owner@Example.com");
    await expect(createScannerRegistrationIntent(scan, body)).resolves.toEqual({
      sent: true,
    });
    const firstLink = latestLink("owner@example.com", "registration");
    await expect(createScannerRegistrationIntent(scan, body)).resolves.toEqual({
      sent: true,
    });
    const secondLink = latestLink("owner@example.com", "registration");
    expect(await db.select().from(leads)).toHaveLength(0);
    const intents = await db
      .select()
      .from(registrationIntents)
      .where(eq(registrationIntents.scanId, scanId));
    expect(intents).toHaveLength(2);
    expect(intents.filter((intent) => intent.consumedAt === null)).toHaveLength(2);
    expect(JSON.stringify(intents)).not.toContain("Owner@Example.com");
    expect(firstLink.tokenHash).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(secondLink.tokenHash).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(JSON.stringify(intents)).not.toContain(firstLink.token);
    expect(JSON.stringify(intents)).not.toContain(secondLink.token);

    const finalized = await Promise.all([
      verifyAndFinalizeScannerIdentity(firstLink.state, firstLink.token),
      verifyAndFinalizeScannerIdentity(secondLink.state, secondLink.token),
    ]);
    expect(finalized).toEqual([
      expect.objectContaining({ scanId }),
      expect.objectContaining({ scanId }),
    ]);
    const ownerLead = onlyRow(
      await db
        .select()
        .from(leads)
        .where(eq(leads.emailLookupHash, hmacHex(tokenHmacSecret, "email", "owner@example.com"))),
    );
    expect(ownerLead).toBeDefined();
    expect(
      await db.select().from(leadScans).where(eq(leadScans.leadId, ownerLead.id)),
    ).toHaveLength(1);
    expect(
      await db.select().from(reportSessions).where(eq(reportSessions.leadId, ownerLead.id)),
    ).toHaveLength(2);
    expect(
      await getDatabase().pool.query<{ count: string }>(
        "select count(*)::text as count from analytics_events where scan_id = $1 and name = 'registration_completed'",
        [scanId],
      ),
    ).toMatchObject({ rows: [{ count: "1" }] });
  });

  it("unlocks a report without a phone and stores none for the lead", async () => {
    const { db } = getDatabase();
    const { scan } = await createFreshCompletedScan("no-phone-registration");
    const sourceChecks = await db.select().from(scanChecks).where(eq(scanChecks.scanId, scanId));
    await db
      .insert(scanChecks)
      .values(sourceChecks.map((check) => ({ ...check, scanId: scan.id })));

    const email = "no-phone@example.com";
    await createScannerRegistrationIntent(
      scan,
      { ...registrationBody(email), phone: undefined },
      {},
    );
    const link = latestLink(email, "registration");
    const emailLookupHash = hmacHex(tokenHmacSecret, "email", email);
    const intent = onlyRow(
      await db
        .select()
        .from(registrationIntents)
        .where(
          and(
            eq(registrationIntents.scanId, scan.id),
            eq(registrationIntents.emailLookupHash, emailLookupHash),
          ),
        ),
    );
    expect(intent.phoneE164Ciphertext).toBeNull();
    expect(intent.phoneLookupHash).toBeNull();

    const finalized = await verifyAndFinalizeScannerIdentity(link.state, link.token);
    expect(finalized?.scanId).toBe(scan.id);
    const lead = onlyRow(
      await db.select().from(leads).where(eq(leads.emailLookupHash, emailLookupHash)),
    );
    expect(lead.phoneE164Ciphertext).toBeNull();
    expect(lead.phoneLookupHash).toBeNull();
  });

  it("stores phone only encrypted and finalizes cabinet-backed identity once", async () => {
    const { db } = getDatabase();
    const { scan, accessToken } = await createFreshCompletedScan("encrypted-registration");
    const sourceChecks = await db.select().from(scanChecks).where(eq(scanChecks.scanId, scanId));
    await db
      .insert(scanChecks)
      .values(sourceChecks.map((check) => ({ ...check, scanId: scan.id })));
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

    const email = "cabinet-new@example.com";
    const partnerClickId = "Xk8sJ2QpR4vN7bL0aZ9wQg";
    await createScannerRegistrationIntent(scan, registrationBody(email), {
      partnerClickId,
    });
    const firstLink = latestLink(email, "registration");
    const emailLookupHash = hmacHex(tokenHmacSecret, "email", email);
    const activeIntent = onlyRow(
      await db
        .select()
        .from(registrationIntents)
        .where(
          and(
            eq(registrationIntents.scanId, scan.id),
            eq(registrationIntents.emailLookupHash, emailLookupHash),
            isNull(registrationIntents.consumedAt),
          ),
        ),
    );
    expect(activeIntent.callbackStateHash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(activeIntent)).not.toContain("+14155550123");
    expect(JSON.stringify(activeIntent)).not.toContain(partnerClickId);

    await expect(
      createScannerRegistrationIntent(scan, registrationBody(email), {
        partnerClickId,
        sendReportLink: async () => "unavailable",
      }),
    ).rejects.toThrow("cabinet_identity_unavailable");
    expect(
      (
        await db
          .select()
          .from(registrationIntents)
          .where(
            and(
              eq(registrationIntents.scanId, scan.id),
              eq(registrationIntents.emailLookupHash, emailLookupHash),
              isNull(registrationIntents.consumedAt),
            ),
          )
      )[0]?.id,
    ).toBe(activeIntent.id);

    await expect(
      verifyAndFinalizeScannerIdentity(firstLink.state, "Z".repeat(32)),
    ).resolves.toBeUndefined();
    const finalized = await verifyAndFinalizeScannerIdentity(firstLink.state, firstLink.token);
    expect(finalized?.scanId).toBe(scan.id);
    if (!finalized) throw new Error("finalizing a verified link opened no session");
    const authorizedCookie = `${REPORT_SESSION_COOKIE}=${finalized.sessionToken}`;
    expect(
      (
        await getContactAccess(
          new NextRequest(`http://localhost:3000/api/v2/scans/${scan.id}/contact-access`),
          { params: Promise.resolve({ id: scan.id }) },
        )
      ).status,
    ).toBe(401);
    expect(
      (
        await getContactAccess(
          new NextRequest(`http://localhost:3000/api/v2/scans/${scan.id}/contact-access`, {
            headers: { cookie: authorizedCookie },
          }),
          { params: Promise.resolve({ id: scan.id }) },
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await getTeaserPrompt(
          new NextRequest(
            `http://localhost:3000/api/v1/scans/${scan.id}/remediation-prompt?scope=teaser`,
            { headers: { authorization: `Bearer ${accessToken}` } },
          ),
          { params: Promise.resolve({ id: scan.id }) },
        )
      ).status,
    ).toBe(401);
    expect(
      (
        await getTeaserPrompt(
          new NextRequest(
            `http://localhost:3000/api/v1/scans/${scan.id}/remediation-prompt?scope=teaser`,
            { headers: { cookie: authorizedCookie } },
          ),
          { params: Promise.resolve({ id: scan.id }) },
        )
      ).status,
    ).toBe(200);
    const verifiedDownload = await downloadTeaserPrompt(
      new NextRequest(`http://localhost:3000/api/v1/scans/${scan.id}/remediation-prompt/download`, {
        headers: { cookie: authorizedCookie },
      }),
      { params: Promise.resolve({ id: scan.id }) },
    );
    expect(verifiedDownload.status).toBe(200);
    expect(verifiedDownload.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
    const lead = onlyRow(
      await db.select().from(leads).where(eq(leads.emailLookupHash, emailLookupHash)),
    );
    expect(lead.phoneE164Ciphertext).not.toContain("+14155550123");
    expect(lead.phoneLookupHash).toMatch(/^[a-f0-9]{64}$/);
    expect(
      await db
        .select()
        .from(deliveryOutbox)
        .where(eq(deliveryOutbox.destination, "partner_tracker")),
    ).toHaveLength(1);
    await expect(
      verifyAndFinalizeScannerIdentity(firstLink.state, firstLink.token),
    ).resolves.toBeUndefined();

    await createScannerRegistrationIntent(scan, registrationBody(email), {
      partnerClickId,
    });
    const repeatLink = latestLink(email, "registration");
    await expect(
      verifyAndFinalizeScannerIdentity(repeatLink.state, repeatLink.token),
    ).resolves.toMatchObject({ scanId: scan.id });
    expect(
      await db
        .select()
        .from(deliveryOutbox)
        .where(eq(deliveryOutbox.destination, "partner_tracker")),
    ).toHaveLength(1);

    const { scan: revokedScan } = await createFreshCompletedScan("revoked-partner");
    const revokedConsentId = createUuidV7();
    await db.insert(consentSnapshots).values({
      id: revokedConsentId,
      sessionId: revokedScan.sessionId,
      policyVersion: "consent-v1.0.0",
      categories: {
        essential_processing: true,
        ads_measurement: false,
      },
      source: "test_withdrawal",
    });
    await db
      .update(sessions)
      .set({ consentSnapshotId: revokedConsentId })
      .where(eq(sessions.id, revokedScan.sessionId));
    const revokedEmail = "revoked-partner@example.com";
    await createScannerRegistrationIntent(revokedScan, registrationBody(revokedEmail), {
      partnerClickId,
    });
    const revokedLink = latestLink(revokedEmail, "registration");
    await expect(
      verifyAndFinalizeScannerIdentity(revokedLink.state, revokedLink.token),
    ).resolves.toMatchObject({ scanId: revokedScan.id });
    expect(
      await db
        .select()
        .from(deliveryOutbox)
        .where(eq(deliveryOutbox.destination, "partner_tracker")),
    ).toHaveLength(1);
  });

  it("verifies once, authorizes 18-row report and a revocable safe share", async () => {
    const scan = onlyRow(
      await getDatabase().db.select().from(scans).where(eq(scans.id, scanId)).limit(1),
    );
    await createScannerRegistrationIntent(scan, registrationBody("owner@example.com"));
    const link = latestLink("owner@example.com", "registration");
    expect(await getFullReport(scanId, undefined)).toBeUndefined();
    const verified = await verifyAndFinalizeScannerIdentity(link.state, link.token);
    expect(verified).toMatchObject({ scanId });
    if (!verified) throw new Error("verifying the identity link opened no session");
    expect(await verifyAndFinalizeScannerIdentity(link.state, link.token)).toBeUndefined();
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
    expect(fullDownload.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
    expect(fullDownload.headers.get("content-disposition")).toBe(
      'attachment; filename="agentify-complete-implementation-prompt.md"',
    );
    expect(await fullDownload.text()).toContain("# Agentify remediation implementation prompt");
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
    expect(await getDatabase().db.select().from(scanShares)).toHaveLength(0);
    const unauthorizedPreview = await previewShare(
      new NextRequest(`http://localhost:3000/api/v1/scans/${scanId}/share-preview`),
      { params: Promise.resolve({ id: scanId }) },
    );
    expect(unauthorizedPreview.status).toBe(404);
    const previewResponse = await previewShare(
      new NextRequest(`http://localhost:3000/api/v1/scans/${scanId}/share-preview`, {
        headers: { authorization: `Bearer ${scanAccessToken}` },
      }),
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
    expect(await getDatabase().db.select().from(scanShares)).toHaveLength(0);
    const leadId = onlyRow(
      await getDatabase()
        .db.select({ leadId: leadScans.leadId })
        .from(leadScans)
        .where(eq(leadScans.scanId, scanId))
        .limit(1),
    ).leadId;
    process.env.PUBLIC_SHARE_ENABLED = "false";
    expect(
      await createPublicShare(
        scanId,
        { verifiedLeadId: leadId, scanTokenAuthorized: false },
        false,
      ),
    ).toBeUndefined();
    expect(await getDatabase().db.select().from(scanShares)).toHaveLength(0);
    process.env.PUBLIC_SHARE_ENABLED = "true";
    const shared = await createPublicShare(
      scanId,
      { verifiedLeadId: leadId, scanTokenAuthorized: false },
      false,
    );
    expect(shared && !shared.conflict).toBe(true);
    if (!shared || shared.conflict) throw new Error("share_failed");
    const publishedPreview = await previewShare(
      new NextRequest(`http://localhost:3000/api/v1/scans/${scanId}/share-preview`, {
        headers: { authorization: `Bearer ${scanAccessToken}` },
      }),
      { params: Promise.resolve({ id: scanId }) },
    );
    expect(await publishedPreview.json()).toMatchObject({
      existing_share: {
        slug: shared.slug,
        public_url: `http://localhost:3000/s/${shared.slug}`,
        status: "published",
      },
    });
    expect((await getPublicShare(shared.slug))?.snapshot).toEqual({
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
    expect(
      await getDatabase().pool.query<{
        name: string;
        count: string;
        once_count: string;
      }>(
        `select name, count(*)::text as count, count(once_key)::text as once_count
         from analytics_events
         where scan_id = $1 and name in ('registration_completed', 'result_shared')
         group by name order by name`,
        [scanId],
      ),
    ).toMatchObject({
      rows: [
        { name: "registration_completed", count: "1", once_count: "1" },
        { name: "result_shared", count: "1", once_count: "1" },
      ],
    });
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
    const stored = onlyRow(
      await getDatabase().db.select().from(scans).where(eq(scans.id, first.scanId)).limit(1),
    );
    expect(stored.status).toBe("queued");
    const jobCount = async (id: string) =>
      (
        await getDatabase().pool.query<{ count: string }>(
          "select count(*)::text as count from pgboss.job where data->>'scan_id' = $1",
          [id],
        )
      ).rows[0]?.count;
    expect(await jobCount(first.scanId)).toBe("1");
    const stableReplay = await createOrReplayScan(body, stableKey, first.anonymousToken);
    expect(stableReplay.scanId).toBe(first.scanId);
    expect(await jobCount(first.scanId)).toBe("1");
    expect((await createOrReplayScan(body, stableKey, first.anonymousToken, true)).conflict).toBe(
      true,
    );
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
    expect(initial.filter((result) => result === "challenge_required")).toHaveLength(2);
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
    expect(await readRateCount(ipKey, "scan_ip_hour", afterRollingExpiry)).toBe(1);
  });

  it("spends a cabinet mail link once and refuses mismatched or cross-site confirmation", async () => {
    const { db } = getDatabase();
    const { scan } = await createFreshCompletedScan("mail-link");
    const requestLink = async (email: string) => {
      await createScannerRegistrationIntent(scan, registrationBody(email));
      const link = latestLink(email, "registration");
      return { state: link.state, token: link.token };
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
          eq(leads.emailLookupHash, hmacHex(tokenHmacSecret, "email", "scanner-live@example.com")),
        ),
    ).toHaveLength(0);
    expect((await finalizeRequest(first, "https://foreign.example")).status).toBe(403);
    expect((await finalizeRequest({ state: second.state, token: first.token })).status).toBe(401);
    const [winner, replay] = await Promise.all([finalizeRequest(first), finalizeRequest(first)]);
    expect([winner.status, replay.status].sort()).toEqual([200, 401]);
    const successful = winner.status === 200 ? winner : replay;
    expect(successful.headers.get("set-cookie")).toContain(REPORT_SESSION_COOKIE);
    expect(successful.headers.get("set-cookie")).not.toContain("scanner-auth");
    expect((await finalizeRequest(first)).status).toBe(401);
    const linked = onlyRow(
      await db
        .select()
        .from(leads)
        .where(
          eq(leads.emailLookupHash, hmacHex(tokenHmacSecret, "email", "scanner-live@example.com")),
        ),
    );
    expect(linked.verifiedAt).toBeInstanceOf(Date);
    expect(
      await db.select().from(reportSessions).where(eq(reportSessions.leadId, linked.id)),
    ).toHaveLength(1);
  });

  it("converges two valid cabinet links for one email on one lead", async () => {
    const { db } = getDatabase();
    const email = "scanner-concurrent@example.com";
    const linksForEmail: LinkRecord[] = [];
    const scanIds: string[] = [];
    for (let index = 0; index < 2; index += 1) {
      const { scan } = await createFreshCompletedScan(`concurrent-${index}`);
      scanIds.push(scan.id);
      await createScannerRegistrationIntent(scan, registrationBody(email));
      linksForEmail.push(latestLink(email, "registration"));
    }
    const responses = await Promise.all(
      linksForEmail.map((link) => finalizeRequest({ state: link.state, token: link.token })),
    );
    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    const matchingLeads = await db
      .select()
      .from(leads)
      .where(eq(leads.emailLookupHash, hmacHex(tokenHmacSecret, "email", email)));
    expect(matchingLeads).toHaveLength(1);
    const lead = onlyRow(matchingLeads);
    expect(
      (await db.select().from(leadScans).where(eq(leadScans.leadId, lead.id)))
        .map((row) => row.scanId)
        .sort(),
    ).toEqual(scanIds.sort());
    expect(
      await db.select().from(reportSessions).where(eq(reportSessions.leadId, lead.id)),
    ).toHaveLength(2);
  });

  it("does not revive an anonymized scan when deletion wins during link sending", async () => {
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
      verifiedAt: new Date(),
      firstSegment: "owner",
      firstSessionId: original.sessionId,
    });
    await db.update(scans).set({ leadId }).where(eq(scans.id, original.id));
    await db.insert(leadScans).values({
      leadId,
      scanId: original.id,
      siteOwnershipClaim: true,
    });
    await db.insert(waitlistEntries).values({
      id: createUuidV7(),
      leadId,
      scanId: original.id,
    });
    const scan = onlyRow(await db.select().from(scans).where(eq(scans.id, original.id)));
    await createScannerRegistrationIntent(scan, registrationBody(email));
    const firstLink = latestLink(email, "registration");
    let markSending!: () => void;
    let releaseSending!: () => void;
    const sending = new Promise<void>((resolve) => {
      markSending = resolve;
    });
    const continueSending = new Promise<void>((resolve) => {
      releaseSending = resolve;
    });
    const lateRequest = createScannerRegistrationIntent(scan, registrationBody(email), {
      sendReportLink: async (address, state) => {
        markSending();
        await continueSending;
        return (
          await getCabinetReportIdentityClient().sendReportLink({
            email: address,
            intentKind: "registration",
            state,
          })
        ).status;
      },
    });
    await sending;
    await expect(requestScannerIdentityDeletion({ leadId })).resolves.toBe("completed");
    releaseSending();
    await expect(lateRequest).rejects.toThrow("registration_scan_unavailable");
    expect(
      (
        await finalizeRequest({
          state: firstLink.state,
          token: firstLink.token,
        })
      ).status,
    ).toBe(401);
    expect((await db.select().from(scans).where(eq(scans.id, scan.id)))[0]?.leadId).toBeNull();
    expect((await db.select().from(leads).where(eq(leads.id, leadId)))[0]?.role).toBe("deleted");
  });

  it("keeps an admitted cabinet link valid when the scan bearer expires during delivery", async () => {
    const { db } = getDatabase();
    const { scan } = await createFreshCompletedScan("bearer-expiry");
    const email = "scanner-bearer-expiry@example.com";
    const result = await createScannerRegistrationIntent(scan, registrationBody(email), {
      sendReportLink: async (address, state) => {
        const sent = await getCabinetReportIdentityClient().sendReportLink({
          email: address,
          intentKind: "registration",
          state,
        });
        await db
          .update(scans)
          .set({ accessTokenExpiresAt: new Date(Date.now() - 1_000) })
          .where(eq(scans.id, scan.id));
        return sent.status;
      },
    });
    expect(result.sent).toBe(true);
    const link = latestLink(email, "registration");
    const response = await finalizeRequest({
      state: link.state,
      token: link.token,
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toContain(REPORT_SESSION_COOKIE);
  });

  it("serializes confirmation with deletion and leaves the scan anonymized", async () => {
    const { db, pool } = getDatabase();
    const { scan } = await createFreshCompletedScan("confirm-delete");
    const email = "scanner-confirm-delete@example.com";
    const config = getServerConfig();
    const leadId = createUuidV7();
    await db.insert(leads).values({
      id: leadId,
      emailNormalizedCiphertext: encryptEmail(email, config.encryptionKey),
      emailLookupHash: hmacHex(config.hmacSecret, "email", email),
      role: "developer",
      verifiedAt: new Date(),
      firstSegment: "owner",
      firstSessionId: scan.sessionId,
    });
    await db.update(scans).set({ leadId }).where(eq(scans.id, scan.id));
    await db.insert(leadScans).values({
      leadId,
      scanId: scan.id,
      siteOwnershipClaim: true,
    });
    await db.insert(waitlistEntries).values({
      id: createUuidV7(),
      leadId,
      scanId: scan.id,
    });
    await createScannerRegistrationIntent(scan, registrationBody(email));
    const link = latestLink(email, "registration");
    await admin.pool.query(`create function hold_report_session_for_deletion() returns trigger
      language plpgsql as $$ begin
        if new.lead_id = '${leadId}'::uuid then perform pg_advisory_xact_lock(479926); end if;
        return new;
      end $$`);
    await admin.pool.query(`create trigger hold_report_session_for_deletion before insert
      on report_sessions for each row execute function hold_report_session_for_deletion()`);
    const blocker = await admin.pool.connect();
    await blocker.query("begin");
    await blocker.query("select pg_advisory_xact_lock(479926)");
    let confirmation: Promise<Response> | undefined;
    let deletion: ReturnType<typeof requestScannerIdentityDeletion> | undefined;
    try {
      confirmation = finalizeRequest({ state: link.state, token: link.token });
      let confirmationBlocked = false;
      for (let attempt = 0; attempt < 30; attempt += 1) {
        const state = await pool.query<{ count: number }>(
          `select count(*)::int as count from pg_stat_activity
           where datname = current_database() and wait_event_type = 'Lock'
             and query like '%report_sessions%'`,
        );
        if ((state.rows[0]?.count ?? 0) > 0) {
          confirmationBlocked = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(confirmationBlocked).toBe(true);
      deletion = requestScannerIdentityDeletion({ leadId });
      expect(
        await Promise.race([
          deletion.then(() => true),
          new Promise<false>((resolve) => setTimeout(() => resolve(false), 150)),
        ]),
      ).toBe(false);
    } finally {
      await blocker.query("commit");
      blocker.release();
      await Promise.allSettled([confirmation, deletion]);
      await admin.pool.query("drop trigger hold_report_session_for_deletion on report_sessions");
      await admin.pool.query("drop function hold_report_session_for_deletion() ");
    }
    if (!confirmation || !deletion)
      throw new Error("the blocked confirmation and deletion never started");
    expect((await confirmation).status).toBe(200);
    await expect(deletion).resolves.toBe("completed");
    const after = onlyRow(await db.select().from(scans).where(eq(scans.id, scan.id)));
    expect(after.leadId).toBeNull();
    expect(after.sessionId).not.toBe(scan.sessionId);
    expect(after.submittedUrlRedacted).toBe("redacted://deleted");
  });

  it("serializes cross-email confirmation with deletion of the scan's old owner", async () => {
    const { db, pool } = getDatabase();
    const { scan } = await createFreshCompletedScan("cross-email-delete");
    const oldEmail = "scanner-old-owner@example.com";
    const newEmail = "scanner-new-owner@example.com";
    const config = getServerConfig();
    const oldLeadId = createUuidV7();
    await db.insert(leads).values({
      id: oldLeadId,
      emailNormalizedCiphertext: encryptEmail(oldEmail, config.encryptionKey),
      emailLookupHash: hmacHex(config.hmacSecret, "email", oldEmail),
      role: "developer",
      verifiedAt: new Date(),
      firstSegment: "owner",
      firstSessionId: scan.sessionId,
    });
    await db.update(scans).set({ leadId: oldLeadId }).where(eq(scans.id, scan.id));
    await db.insert(leadScans).values({
      leadId: oldLeadId,
      scanId: scan.id,
      siteOwnershipClaim: true,
    });
    await db.insert(waitlistEntries).values({
      id: createUuidV7(),
      leadId: oldLeadId,
      scanId: scan.id,
    });
    await createScannerRegistrationIntent(scan, registrationBody(newEmail));
    const link = latestLink(newEmail, "registration");
    await admin.pool.query(`create function hold_cross_email_report_session() returns trigger
      language plpgsql as $$ begin perform pg_advisory_xact_lock(479927); return new; end $$`);
    await admin.pool.query(`create trigger hold_cross_email_report_session before insert
      on report_sessions for each row execute function hold_cross_email_report_session()`);
    const blocker = await admin.pool.connect();
    await blocker.query("begin");
    await blocker.query("select pg_advisory_xact_lock(479927)");
    let confirmation: Promise<Response> | undefined;
    let deletion: ReturnType<typeof requestScannerIdentityDeletion> | undefined;
    try {
      confirmation = finalizeRequest({ state: link.state, token: link.token });
      let confirmationBlocked = false;
      for (let attempt = 0; attempt < 30; attempt += 1) {
        const state = await pool.query<{ count: number }>(
          `select count(*)::int as count from pg_stat_activity
           where datname = current_database() and wait_event_type = 'Lock'
             and query like '%report_sessions%'`,
        );
        if ((state.rows[0]?.count ?? 0) > 0) {
          confirmationBlocked = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(confirmationBlocked).toBe(true);
      deletion = requestScannerIdentityDeletion({ leadId: oldLeadId });
      expect(
        await Promise.race([
          deletion.then(() => true),
          new Promise<false>((resolve) => setTimeout(() => resolve(false), 150)),
        ]),
      ).toBe(false);
    } finally {
      await blocker.query("commit");
      blocker.release();
      await Promise.allSettled([confirmation, deletion]);
      await admin.pool.query("drop trigger hold_cross_email_report_session on report_sessions");
      await admin.pool.query("drop function hold_cross_email_report_session()");
    }
    if (!confirmation || !deletion)
      throw new Error("the blocked confirmation and deletion never started");
    expect((await confirmation).status).toBe(200);
    await expect(deletion).resolves.toBe("completed");
    const after = onlyRow(await db.select().from(scans).where(eq(scans.id, scan.id)));
    expect(after.leadId).toBeNull();
    expect(after.sessionId).not.toBe(scan.sessionId);
    expect(after.submittedUrlRedacted).toBe("redacted://deleted");
  });

  it("reports the fourth registration limit instead of claiming email was sent", async () => {
    const { scan, accessToken } = await createFreshCompletedScan("rate-limit");
    const body = registrationBody("scanner-rate-limit@example.com");
    for (let index = 0; index < 3; index += 1) {
      await expect(createScannerRegistrationIntent(scan, body)).resolves.toEqual({ sent: true });
    }
    process.env.REGISTRATION_ENABLED = "true";
    try {
      const response = await requestScannerRegistration(
        new NextRequest(`http://localhost:3000/api/v2/scans/${scan.id}/registrations`, {
          method: "POST",
          headers: {
            origin: "http://localhost:3000",
            "content-type": "application/json",
            authorization: `Bearer ${accessToken}`,
          },
          body: JSON.stringify(body),
        }),
        { params: Promise.resolve({ id: scan.id }) },
      );
      expect(response.status).toBe(429);
      expect(await response.text()).not.toContain("verification_sent");
    } finally {
      process.env.REGISTRATION_ENABLED = "false";
    }
  });

  it("resumes a consumed registration receipt after local failure and original intent expiry", async () => {
    const email = "registration-expiry@example.com";
    const scan = await createCompletedScan("registration-expiry");
    await expect(createScannerRegistrationIntent(scan, registrationBody(email))).resolves.toEqual({
      sent: true,
    });
    const link = latestLink(email, "registration");

    await installReportSessionFailureTrigger();
    await expectLocalReportSessionFailure(verifyAndFinalizeScannerIdentity(link.state, link.token));
    expect(link.consumeCount).toBe(1);
    expect(
      await getDatabase()
        .db.select()
        .from(scannerIdentityCompletions)
        .where(eq(scannerIdentityCompletions.tokenHash, link.tokenHash)),
    ).toEqual([]);

    await getDatabase()
      .db.update(registrationIntents)
      .set({ expiresAt: new Date(Date.now() - 1) })
      .where(eq(registrationIntents.callbackStateHash, sha256(link.state)));
    await removeReportSessionFailureTrigger();

    const finalized = await verifyAndFinalizeScannerIdentity(link.state, link.token);
    expect(finalized).toMatchObject({
      scanId: scan.id,
      cabinetActionUrl: expect.stringContaining("/cabinet/sign-in/open"),
    });
    expect(link.consumeCount).toBe(2);
    expect(link.acknowledgeCount).toBe(1);
    expect(link.issueCount).toBe(1);
    expect(
      await getDatabase()
        .db.select()
        .from(scannerIdentityCompletions)
        .where(eq(scannerIdentityCompletions.tokenHash, link.tokenHash)),
    ).toHaveLength(1);
    const lead = onlyRow(
      await getDatabase()
        .db.select()
        .from(leads)
        .where(eq(leads.emailLookupHash, hmacHex(tokenHmacSecret, "email", email))),
    );
    expect(
      await getDatabase()
        .db.select()
        .from(reportSessions)
        .where(eq(reportSessions.leadId, lead.id)),
    ).toHaveLength(1);
    expect(decryptEmail(lead.emailNormalizedCiphertext, Buffer.alloc(32, 9))).toBe(email);
    expect(lead.emailLookupHash).toBe(hmacHex(tokenHmacSecret, "email", email));

    await expect(verifyAndFinalizeScannerIdentity(link.state, link.token)).resolves.toBeUndefined();
    expect(link.acknowledgeCount).toBe(2);
    expect(link.issueCount).toBe(1);
    expect(
      await getDatabase()
        .db.select()
        .from(reportSessions)
        .where(eq(reportSessions.leadId, lead.id)),
    ).toHaveLength(1);
  });

  it("refuses untouched expiry and an expired cabinet completion deadline", async () => {
    const untouchedEmail = "untouched-expired@example.com";
    const untouchedScan = await createCompletedScan("untouched-expired");
    await createScannerRegistrationIntent(untouchedScan, registrationBody(untouchedEmail));
    const untouched = latestLink(untouchedEmail, "registration");
    untouched.refuseConsume = true;
    await getDatabase()
      .db.update(registrationIntents)
      .set({ expiresAt: new Date(Date.now() - 1) })
      .where(eq(registrationIntents.callbackStateHash, sha256(untouched.state)));
    await expect(
      verifyAndFinalizeScannerIdentity(untouched.state, untouched.token),
    ).resolves.toBeUndefined();

    const deadlineEmail = "deadline-expired@example.com";
    const deadlineScan = await createCompletedScan("deadline-expired");
    await createScannerRegistrationIntent(deadlineScan, registrationBody(deadlineEmail));
    const deadline = latestLink(deadlineEmail, "registration");
    await installReportSessionFailureTrigger();
    await expectLocalReportSessionFailure(
      verifyAndFinalizeScannerIdentity(deadline.state, deadline.token),
    );
    await removeReportSessionFailureTrigger();
    deadline.completionDeadline = new Date(Date.now() - 1);
    await getDatabase()
      .db.update(registrationIntents)
      .set({ expiresAt: new Date(Date.now() - 1) })
      .where(eq(registrationIntents.callbackStateHash, sha256(deadline.state)));
    await expect(
      verifyAndFinalizeScannerIdentity(deadline.state, deadline.token),
    ).resolves.toBeUndefined();
    expect(
      await getDatabase()
        .db.select()
        .from(scannerIdentityCompletions)
        .where(eq(scannerIdentityCompletions.tokenHash, deadline.tokenHash)),
    ).toEqual([]);
  });

  it("resumes acknowledgement from the durable completion without replaying issue", async () => {
    const email = "ack-resume@example.com";
    const scan = await createCompletedScan("ack-resume");
    await createScannerRegistrationIntent(scan, registrationBody(email));
    const link = latestLink(email, "registration");
    link.acknowledgeFailures = 1;

    await expect(verifyAndFinalizeScannerIdentity(link.state, link.token)).rejects.toThrow(
      "cabinet_identity_unavailable",
    );
    expect(
      await getDatabase()
        .db.select()
        .from(scannerIdentityCompletions)
        .where(eq(scannerIdentityCompletions.tokenHash, link.tokenHash)),
    ).toHaveLength(1);
    expect(link.issueCount).toBe(0);

    await expect(verifyAndFinalizeScannerIdentity(link.state, link.token)).resolves.toBeUndefined();
    expect(link.consumeCount).toBe(1);
    expect(link.acknowledgeCount).toBe(2);
    expect(link.issueCount).toBe(0);
    expect(
      await getDatabase()
        .db.select()
        .from(reportSessions)
        .where(
          eq(
            reportSessions.leadId,
            onlyRow(
              await getDatabase()
                .db.select({ id: leads.id })
                .from(leads)
                .where(eq(leads.emailLookupHash, hmacHex(tokenHmacSecret, "email", email))),
            ).id,
          ),
        ),
    ).toHaveLength(1);
  });

  it("gives exact recovery authority precedence and resumes it after expiry", async () => {
    const email = "recovery-expiry@example.com";
    const scan = await createCompletedScan("recovery-expiry");
    const leadId = createUuidV7();
    const emailHash = hmacHex(tokenHmacSecret, "email", email);
    await getDatabase()
      .db.insert(leads)
      .values({
        id: leadId,
        emailNormalizedCiphertext: encryptEmail(email, Buffer.alloc(32, 9)),
        emailLookupHash: emailHash,
        role: "business_owner",
        verifiedAt: new Date(),
        firstSegment: "owner",
        firstSessionId: scan.sessionId,
      });
    await getDatabase().db.insert(leadScans).values({
      leadId,
      scanId: scan.id,
      siteOwnershipClaim: true,
    });
    await getDatabase().db.insert(waitlistEntries).values({
      id: createUuidV7(),
      leadId,
      scanId: scan.id,
    });

    await requestScannerReportRecovery({
      email,
      ip: "203.0.113.80",
    });
    const link = latestLink(email, "recovery");
    await getDatabase()
      .db.insert(registrationIntents)
      .values({
        id: createUuidV7(),
        scanId: scan.id,
        sessionId: scan.sessionId,
        callbackStateHash: sha256(link.state),
        emailNormalizedCiphertext: encryptEmail(email, Buffer.alloc(32, 9)),
        emailLookupHash: emailHash,
        phoneE164Ciphertext: encryptEmail("+14155550124", Buffer.alloc(32, 9)),
        phoneLookupHash: "phone-hash-recovery",
        role: "business_owner",
        siteOwnershipClaim: true,
        datasetReuseAcknowledged: true,
        expiresAt: new Date(Date.now() + 60_000),
      });

    await installReportSessionFailureTrigger();
    await expectLocalReportSessionFailure(verifyAndFinalizeScannerIdentity(link.state, link.token));
    await removeReportSessionFailureTrigger();
    await getDatabase()
      .db.update(scannerRecoveryIntents)
      .set({ expiresAt: new Date(Date.now() - 1) })
      .where(eq(scannerRecoveryIntents.tokenHash, link.tokenHash));

    await expect(verifyAndFinalizeScannerIdentity(link.state, link.token)).resolves.toMatchObject({
      scanId: scan.id,
    });
    const recovery = onlyRow(
      await getDatabase()
        .db.select()
        .from(scannerRecoveryIntents)
        .where(eq(scannerRecoveryIntents.tokenHash, link.tokenHash)),
    );
    expect(recovery.consumedAt).toBeInstanceOf(Date);
    const registration = onlyRow(
      await getDatabase()
        .db.select()
        .from(registrationIntents)
        .where(eq(registrationIntents.callbackStateHash, sha256(link.state))),
    );
    expect(registration.consumedAt).toBeNull();
  });

  it("sends the same recovery request outward for unknown and deleting addresses", async () => {
    const unknown = "unknown-recovery@example.com";
    await expect(
      requestScannerReportRecovery({ email: unknown, ip: "203.0.113.81" }),
    ).resolves.toBe("accepted");
    expect(latestLink(unknown, "recovery")).toBeDefined();

    const email = "deleting-recovery@example.com";
    const scan = await createCompletedScan("deleting-recovery");
    await getDatabase()
      .db.insert(leads)
      .values({
        id: createUuidV7(),
        emailNormalizedCiphertext: encryptEmail(email, Buffer.alloc(32, 9)),
        emailLookupHash: hmacHex(tokenHmacSecret, "email", email),
        role: "business_owner",
        verifiedAt: new Date(),
        deletionRequestedAt: new Date(),
        firstSegment: "owner",
        firstSessionId: scan.sessionId,
      });
    await expect(requestScannerReportRecovery({ email, ip: "203.0.113.82" })).resolves.toBe(
      "accepted",
    );
    expect(latestLink(email, "recovery")).toBeDefined();
    expect(
      await getDatabase()
        .db.select()
        .from(scannerRecoveryIntents)
        .where(
          and(
            eq(scannerRecoveryIntents.emailLookupHash, hmacHex(tokenHmacSecret, "email", email)),
            sql`${scannerRecoveryIntents.tokenHash} is not null`,
          ),
        ),
    ).toEqual([]);
  });

  it("recovers an existing report with a purpose-bound fresh cabinet link", async () => {
    const { db, pool } = getDatabase();
    const { scan } = await createFreshCompletedScan("recovery-route");
    const email = "recovery-route-owner@example.com";
    const config = getServerConfig();
    const leadId = createUuidV7();
    const legacyState = "L".repeat(43);
    const legacyIntentId = createUuidV7();
    await db.insert(leads).values({
      id: leadId,
      emailNormalizedCiphertext: encryptEmail(email, config.encryptionKey),
      emailLookupHash: hmacHex(config.hmacSecret, "email", email),
      phoneE164Ciphertext: encryptEmail("+14155550140", config.encryptionKey),
      phoneLookupHash: hmacHex(config.hmacSecret, "phone", "+14155550140"),
      role: "developer",
      verifiedAt: new Date(Date.now() - 86_400_000),
      firstSegment: scan.segment,
      firstSessionId: scan.sessionId,
    });
    await db.insert(leadScans).values({
      leadId,
      scanId: scan.id,
      siteOwnershipClaim: true,
    });
    await db.insert(waitlistEntries).values({
      id: createUuidV7(),
      leadId,
      scanId: scan.id,
    });
    await db.update(scans).set({ leadId }).where(eq(scans.id, scan.id));
    await db.insert(registrationIntents).values({
      id: legacyIntentId,
      scanId: scan.id,
      sessionId: scan.sessionId,
      callbackStateHash: sha256(legacyState),
      emailNormalizedCiphertext: encryptEmail(email, config.encryptionKey),
      emailLookupHash: hmacHex(config.hmacSecret, "email", email),
      phoneE164Ciphertext: encryptEmail("+14155550140", config.encryptionKey),
      phoneLookupHash: hmacHex(config.hmacSecret, "phone", "+14155550140"),
      role: "developer",
      siteOwnershipClaim: true,
      datasetReuseAcknowledged: true,
      expiresAt: new Date(Date.now() - 60_000),
    });
    const beforeConsent = await db.select().from(consentSnapshots);
    const beforeDelivery = await db.select().from(deliveryOutbox);
    const emailRecoveryRequest = (
      address: string,
      state = legacyState,
      origin = "http://localhost:3000",
    ) =>
      handleScannerRecoveryRequest(
        new NextRequest("http://localhost:3000/api/v2/auth/recover", {
          method: "POST",
          headers: {
            origin,
            "content-type": "application/json",
            "x-forwarded-for": "198.51.100.10, 127.0.0.1",
          },
          body: JSON.stringify({
            action: "email",
            email: address,
            state,
            turnstile_token: null,
          }),
        }),
      );

    const requested = await emailRecoveryRequest(email);
    expect(requested.status).toBe(202);
    expect(await requested.json()).toEqual({ status: "recovery_requested" });
    const link = latestLink(email, "recovery");
    expect((await finalizeRequest({ state: "X".repeat(43), token: link.token })).status).toBe(401);
    const finalized = await finalizeRequest({
      state: link.state,
      token: link.token,
    });
    expect(finalized.status).toBe(200);
    const finalizedPayload = await finalized.json();
    expect(finalizedPayload).toMatchObject({
      status: "verified",
      report_url: `/report/${scan.id}`,
    });
    expect(finalizedPayload).not.toHaveProperty("cabinet_action_url");
    const reportCookie = finalized.headers.get("set-cookie");
    if (!reportCookie) throw new Error("the finalize response set no cookie at all");
    expect(reportCookie).toContain(REPORT_SESSION_COOKIE);
    expect(reportCookie).toContain(REPORT_CABINET_HANDOFF_COOKIE);
    const [sessionCookie] = reportCookie.split(";");
    if (!sessionCookie) throw new Error("the finalize response set an empty cookie");
    expect(await db.select().from(consentSnapshots)).toEqual(beforeConsent);
    expect(await db.select().from(deliveryOutbox)).toEqual(beforeDelivery);
    expect(
      (
        await db
          .select()
          .from(registrationIntents)
          .where(eq(registrationIntents.id, legacyIntentId))
      )[0]?.consumedAt,
    ).toBeNull();

    const authenticated = await handleScannerRecoveryRequest(
      new NextRequest("http://localhost:3000/api/v2/auth/recover", {
        method: "POST",
        headers: {
          origin: "http://localhost:3000",
          "content-type": "application/json",
          cookie: sessionCookie,
        },
        body: JSON.stringify({ action: "session", state: legacyState }),
      }),
    );
    expect(authenticated.status).toBe(200);
    expect(await authenticated.json()).toMatchObject({
      report_url: `/report/${scan.id}`,
    });

    const sessionRecoveryRequest = (state: string) =>
      handleScannerRecoveryRequest(
        new NextRequest("http://localhost:3000/api/v2/auth/recover", {
          method: "POST",
          headers: {
            origin: "http://localhost:3000",
            "content-type": "application/json",
            cookie: sessionCookie,
          },
          body: JSON.stringify({ action: "session", state }),
        }),
      );

    const { scan: secondOwnedScan } = await createFreshCompletedScan("same-owner-second-report");
    const secondOwnedState = "S".repeat(43);
    await db.insert(leadScans).values({
      leadId,
      scanId: secondOwnedScan.id,
      siteOwnershipClaim: true,
    });
    await db.insert(waitlistEntries).values({
      id: createUuidV7(),
      leadId,
      scanId: secondOwnedScan.id,
    });
    await db
      .update(scans)
      .set({ leadId, finishedAt: new Date(Date.now() + 60_000) })
      .where(eq(scans.id, secondOwnedScan.id));
    await db.insert(registrationIntents).values({
      id: createUuidV7(),
      scanId: secondOwnedScan.id,
      sessionId: secondOwnedScan.sessionId,
      callbackStateHash: sha256(secondOwnedState),
      emailNormalizedCiphertext: encryptEmail(email, config.encryptionKey),
      emailLookupHash: hmacHex(config.hmacSecret, "email", email),
      phoneE164Ciphertext: encryptEmail("+14155550142", config.encryptionKey),
      phoneLookupHash: hmacHex(config.hmacSecret, "phone", "+14155550142"),
      role: "developer",
      siteOwnershipClaim: true,
      datasetReuseAcknowledged: true,
      expiresAt: new Date(Date.now() + 60_000),
    });

    const secondOwned = await sessionRecoveryRequest(secondOwnedState);
    expect(secondOwned.status).toBe(200);
    expect(await secondOwned.json()).toMatchObject({
      report_url: `/report/${secondOwnedScan.id}`,
    });

    const recoveredExact = await sessionRecoveryRequest(link.state);
    expect(recoveredExact.status).toBe(200);
    expect(await recoveredExact.json()).toMatchObject({
      report_url: `/report/${scan.id}`,
    });

    const unknownState = await sessionRecoveryRequest("U".repeat(43));
    expect(unknownState.status).toBe(202);

    const retiredStateRecovery = await emailRecoveryRequest(email, "U".repeat(43));
    expect(retiredStateRecovery.status).toBe(202);
    const retiredStateLink = latestLink(email, "recovery");
    expect(
      (
        await db
          .select({ scanId: scannerRecoveryIntents.scanId })
          .from(scannerRecoveryIntents)
          .where(eq(scannerRecoveryIntents.tokenHash, retiredStateLink.tokenHash))
      )[0],
    ).toEqual({ scanId: secondOwnedScan.id });

    const { scan: foreignScan } = await createFreshCompletedScan("foreign-recovery-state");
    const foreignState = "F".repeat(43);
    const foreignLeadId = createUuidV7();
    await db.insert(leads).values({
      id: foreignLeadId,
      emailNormalizedCiphertext: encryptEmail(
        "foreign-report-owner@example.com",
        config.encryptionKey,
      ),
      emailLookupHash: hmacHex(config.hmacSecret, "email", "foreign-report-owner@example.com"),
      role: "developer",
      verifiedAt: new Date(),
      firstSegment: foreignScan.segment,
      firstSessionId: foreignScan.sessionId,
    });
    await db.insert(scannerRecoveryIntents).values({
      id: createUuidV7(),
      tokenHash: "R".repeat(43),
      stateHash: sha256(foreignState),
      emailLookupHash: hmacHex(config.hmacSecret, "email", "foreign-report-owner@example.com"),
      leadId: foreignLeadId,
      scanId: foreignScan.id,
      expiresAt: new Date(Date.now() + 60_000),
      activatedAt: new Date(),
    });
    const foreignHint = await sessionRecoveryRequest(foreignState);
    expect(foreignHint.status).toBe(202);

    const ambiguousState = "A".repeat(43);
    await db.insert(scannerRecoveryIntents).values([
      {
        id: createUuidV7(),
        tokenHash: "B".repeat(43),
        stateHash: sha256(ambiguousState),
        emailLookupHash: hmacHex(config.hmacSecret, "email", email),
        leadId,
        scanId: scan.id,
        expiresAt: new Date(Date.now() + 60_000),
        activatedAt: new Date(),
      },
      {
        id: createUuidV7(),
        tokenHash: "C".repeat(43),
        stateHash: sha256(ambiguousState),
        emailLookupHash: hmacHex(config.hmacSecret, "email", email),
        leadId,
        scanId: secondOwnedScan.id,
        expiresAt: new Date(Date.now() + 60_000),
        activatedAt: new Date(),
      },
    ]);
    const ambiguousHint = await sessionRecoveryRequest(ambiguousState);
    expect(ambiguousHint.status).toBe(202);

    const reportSessionToken = sessionCookie.slice(`${REPORT_SESSION_COOKIE}=`.length);
    await expect(getFullReport(scan.id, reportSessionToken)).resolves.toMatchObject({
      scan_id: scan.id,
    });
    await db
      .update(reportSessions)
      .set({ expiresAt: new Date(Date.now() - 1_000) })
      .where(eq(reportSessions.sessionTokenHash, sha256(reportSessionToken)));
    const expiredSession = await handleScannerRecoveryRequest(
      new NextRequest("http://localhost:3000/api/v2/auth/recover", {
        method: "POST",
        headers: {
          origin: "http://localhost:3000",
          "content-type": "application/json",
          cookie: sessionCookie,
        },
        body: JSON.stringify({ action: "session", state: legacyState }),
      }),
    );
    expect(expiredSession.status).toBe(202);

    const unknown = await emailRecoveryRequest("absent-report@example.com");
    expect(unknown.status).toBe(202);
    expect(await unknown.json()).toEqual({ status: "recovery_requested" });
    const unknownLink = latestLink("absent-report@example.com", "recovery");
    expect(
      await db
        .select()
        .from(scannerRecoveryIntents)
        .where(eq(scannerRecoveryIntents.tokenHash, unknownLink.tokenHash)),
    ).toHaveLength(0);
    expect(
      (await emailRecoveryRequest(email, legacyState, "https://attacker.invalid")).status,
    ).toBe(403);
    for (const invalidBody of [{ action: "email" }, { action: "unknown", email }, {}]) {
      const invalid = await handleScannerRecoveryRequest(
        new NextRequest("http://localhost:3000/api/v2/auth/recover", {
          method: "POST",
          headers: {
            origin: "http://localhost:3000",
            "content-type": "application/json",
          },
          body: JSON.stringify(invalidBody),
        }),
      );
      expect(invalid.status).toBe(400);
    }
    expect((await finalizeRequest({ state: link.state, token: link.token })).status).toBe(401);

    const heldConnections = await Promise.all(Array.from({ length: 9 }, () => pool.connect()));
    let saturatedRequest: Promise<Response> | undefined;
    try {
      saturatedRequest = emailRecoveryRequest(email);
      const completedWithOneConnection = await Promise.race([
        saturatedRequest.then(() => true),
        new Promise<false>((resolve) => setTimeout(() => resolve(false), 1_000)),
      ]);
      expect(completedWithOneConnection).toBe(true);
    } finally {
      for (const connection of heldConnections) connection.release();
      await saturatedRequest;
    }
    const expiringLink = latestLink(email, "recovery");
    expiringLink.refuseConsume = true;
    expect(
      (
        await finalizeRequest({
          state: expiringLink.state,
          token: expiringLink.token,
        })
      ).status,
    ).toBe(401);

    await emailRecoveryRequest(email);
    const deletionLink = latestLink(email, "recovery");
    expect(
      await db
        .select()
        .from(scannerRecoveryIntents)
        .where(eq(scannerRecoveryIntents.tokenHash, deletionLink.tokenHash)),
    ).toHaveLength(1);
    await expect(requestScannerIdentityDeletion({ leadId })).resolves.toBe("completed");
    expect(
      await db
        .select()
        .from(scannerRecoveryIntents)
        .where(eq(scannerRecoveryIntents.tokenHash, deletionLink.tokenHash)),
    ).toHaveLength(0);
    expect(
      (
        await finalizeRequest({
          state: deletionLink.state,
          token: deletionLink.token,
        })
      ).status,
    ).toBe(401);
  });
});
