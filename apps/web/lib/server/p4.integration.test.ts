import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";

import { CONSENT_POLICY_VERSION } from "@agentify/analytics";
import { CHECK_DEFINITIONS } from "@agentify/scanner-contracts";
import {
  consentSnapshots,
  createDatabase,
  createUuidV7,
  deliveryOutbox,
  leadScans,
  leads,
  migrateDatabase,
  registrationIntents,
  scanChecks,
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
import { GET as getContactAccess } from "../../app/api/v2/scans/[id]/contact-access/route";
import { POST as requestScannerRegistration } from "../../app/api/v2/scans/[id]/registrations/route";
import { GET as readVisitor } from "../../app/api/v2/session/route";
import { latestReportOf, visitorOf } from "./auth";
import { getCabinetReportIdentityClient } from "./cabinet-report-identity";
import { getServerConfig } from "./config";
import { encryptEmail, hmacHex, sha256 } from "./crypto";
import { getDatabase } from "./database";
import { enqueueScanInTransaction, stopScanQueue } from "./queue";
import { consumeRateLimitsAtomically, consumeScanRateLimits, readRateCount } from "./rate-limit";
import { createPublicShare, getFullReport, getPublicShare, revokePublicShare } from "./reporting";
import { requestScannerIdentityDeletion } from "./scanner-identity-deletion";
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

/**
 * The cabinet's side of the internal route, as the scanner meets it.
 *
 * It keeps what the real cabinet keeps for these questions and nothing else:
 * the links it was asked to send, with their destination and request, and the
 * sessions those links opened. Pressing a link here stands for the press on
 * the cabinet's one-control page, which the cabinet's own suites cover; what
 * this suite is about is what the scanner does with the answers.
 */
type SentLink = { email: string; scanId: string; request: string };

/** The name the stand-in cabinet's session cookie travels under. */
const SESSION_COOKIE = "__Host-agentify.session_token";

const sentLinks: SentLink[] = [];
const cabinetSessions = new Map<string, { email: string; request: string | null }>();
let sessionSequence = 0;
let sendCooldownUntil: Date | undefined;
let cabinetDown = false;
let cabinetServer: Server;
let scanId = "";
let scanAccessToken = "";
const anonymousToken = "p4-attribution-anonymous-token";

function latestLink(email: string): SentLink {
  const record = sentLinks.findLast((candidate) => candidate.email === email);
  if (!record) throw new Error("cabinet_test_link_missing");
  return record;
}

/**
 * Presses a link as the cabinet's one-control page would: a session opens for
 * its address, naming the request it was asked for, and the browser holds its
 * cookie. Returns that browser's cookie header.
 */
function pressLink(link: SentLink): string {
  sessionSequence += 1;
  const value = `session-${sessionSequence}`;
  cabinetSessions.set(value, { email: link.email, request: link.request });
  return `agentify_anonymous=${anonymousToken}; ${SESSION_COOKIE}=${value}`;
}

/** A browser signed in from the cabinet's sign-in page: its session names no request. */
function signedInAs(email: string): string {
  sessionSequence += 1;
  const value = `session-${sessionSequence}`;
  cabinetSessions.set(value, { email, request: null });
  return `${SESSION_COOKIE}=${value}`;
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

const registrationBody = (email: string) => ({
  email,
  phone: "+14155550123",
  role: "business_owner",
  site_is_mine: true,
  marketing_email_opt_in: false,
  dataset_reuse_acknowledged: true as const,
});

async function copyChecks(id: string) {
  const { db } = getDatabase();
  const sourceChecks = await db.select().from(scanChecks).where(eq(scanChecks.scanId, scanId));
  await db.insert(scanChecks).values(sourceChecks.map((check) => ({ ...check, scanId: id })));
}

async function registrationEventsFor(id: string) {
  return (
    await getDatabase().pool.query<{ count: string }>(
      "select count(*)::text as count from analytics_events where scan_id = $1 and name = 'registration_completed'",
      [id],
    )
  ).rows[0]?.count;
}

function registrationRequest(
  id: string,
  accessToken: string,
  body: unknown,
  headers: Record<string, string> = {},
) {
  return requestScannerRegistration(
    new NextRequest(`http://localhost:3000/api/v2/scans/${id}/registrations`, {
      method: "POST",
      headers: {
        origin: "http://localhost:3000",
        "content-type": "application/json",
        authorization: `Bearer ${accessToken}`,
        ...headers,
      },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) },
  );
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
    if (cabinetDown) {
      respondJson(response, 503, { status: "unavailable" });
      return;
    }
    const body = await readJson(request);
    if (body.operation === "send") {
      if (sendCooldownUntil) {
        respondJson(response, 200, {
          status: "cooldown",
          retry_at: sendCooldownUntil.toISOString(),
        });
        return;
      }
      const destination = body.destination as { report: string };
      sentLinks.push({
        email: String(body.email),
        scanId: destination.report,
        request: String(body.request),
      });
      respondJson(response, 200, { status: "accepted" });
      return;
    }
    if (body.operation === "session") {
      const cookies = String(body.cookie)
        .split(";")
        .map((pair) => pair.trim().split("="));
      const held = cookies.find(
        ([name, value]) => name === SESSION_COOKIE && cabinetSessions.has(value ?? ""),
      );
      const session = held ? cabinetSessions.get(held[1] ?? "") : undefined;
      respondJson(
        response,
        200,
        session
          ? {
              status: "signed_in",
              email: session.email,
              request: session.request,
              set_cookie: body.renew
                ? [`${SESSION_COOKIE}=${held?.[1]}; Max-Age=2592000; Path=/; HttpOnly; Secure`]
                : [],
            }
          : { status: "signed_out" },
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
    const firstLink = latestLink("owner@example.com");
    await expect(createScannerRegistrationIntent(scan, body)).resolves.toEqual({
      sent: true,
    });
    const secondLink = latestLink("owner@example.com");
    expect(await db.select().from(leads)).toHaveLength(0);
    const intents = await db
      .select()
      .from(registrationIntents)
      .where(eq(registrationIntents.scanId, scanId));
    expect(intents).toHaveLength(2);
    expect(intents.filter((intent) => intent.consumedAt === null)).toHaveLength(2);
    expect(JSON.stringify(intents)).not.toContain("Owner@Example.com");
    // The link carries the scan and the scanner's request to the cabinet, and
    // nothing else: the address was normalized before it left.
    expect(firstLink).toEqual({ email: "owner@example.com", scanId, request: intents[0]?.id });
    expect(secondLink.request).toBe(intents[1]?.id);

    // Both links pressed, both sessions visiting at once: one lead, one link
    // between it and the scan, one registration.
    const visits = await Promise.all([
      visitorOf(pressLink(firstLink)),
      visitorOf(pressLink(secondLink)),
    ]);
    expect(visits.map((visit) => visit.kind)).toEqual(["person", "person"]);
    const ownerLead = onlyRow(
      await db
        .select()
        .from(leads)
        .where(eq(leads.emailLookupHash, hmacHex(tokenHmacSecret, "email", "owner@example.com"))),
    );
    expect(
      await db.select().from(leadScans).where(eq(leadScans.leadId, ownerLead.id)),
    ).toHaveLength(1);
    expect(await registrationEventsFor(scanId)).toBe("1");
  });

  it("finishes the request its own link was asked for at the session's first visit, once across tabs", async () => {
    // Wherever the navigation began: the report the link leads to, another
    // tab on the landing page, the header's question. Every one of them may
    // be the first, and only one of them finishes it (ADR-0026 §2).
    const { db } = getDatabase();
    const { scan } = await createFreshCompletedScan("first-visit");
    await copyChecks(scan.id);
    const email = "first-visit@example.com";
    await createScannerRegistrationIntent(scan, registrationBody(email));
    const cookie = pressLink(latestLink(email));
    expect(await getFullReport(scan.id, undefined)).toBeUndefined();

    const [report, other, header] = await Promise.all([
      getFullReport(scan.id, cookie),
      visitorOf(cookie),
      visitorOf(cookie, { renew: true }),
    ]);

    expect(report?.checks).toHaveLength(18);
    expect(other).toMatchObject({ kind: "person", email });
    expect(header).toMatchObject({ kind: "person", email });
    expect(await registrationEventsFor(scan.id)).toBe("1");
    const formConsents = async () =>
      (
        await db
          .select({ id: consentSnapshots.id })
          .from(consentSnapshots)
          .where(
            and(
              eq(consentSnapshots.sessionId, scan.sessionId),
              eq(consentSnapshots.source, "report_identity_registration"),
            ),
          )
      ).length;
    // The form's choices are applied once, by the visit that finished it; a
    // later visit must not apply them again over whatever was chosen since.
    expect(await formConsents()).toBe(1);
    const lead = onlyRow(
      await db
        .select()
        .from(leads)
        .where(eq(leads.emailLookupHash, hmacHex(tokenHmacSecret, "email", email))),
    );
    expect(
      await db
        .select()
        .from(waitlistEntries)
        .where(and(eq(waitlistEntries.leadId, lead.id), eq(waitlistEntries.scanId, scan.id))),
    ).toHaveLength(1);
    // A later visit finds it finished and does nothing more.
    await visitorOf(cookie);
    expect(await registrationEventsFor(scan.id)).toBe("1");
    expect(await formConsents()).toBe(1);
  });

  it("never finishes a request for a session of another address", async () => {
    // The request carries what its form said, a marketing choice included, so
    // only the address it was made for may finish it (ADR-0026 §2).
    const { db } = getDatabase();
    const { scan } = await createFreshCompletedScan("other-address");
    const email = "asked-for@example.com";
    await createScannerRegistrationIntent(scan, registrationBody(email));
    const link = latestLink(email);

    const intruder = await visitorOf(pressLink({ ...link, email: "someone-else@example.com" }));

    expect(intruder).toMatchObject({ kind: "person", leadId: null });
    expect(
      onlyRow(
        await db.select().from(registrationIntents).where(eq(registrationIntents.id, link.request)),
      ).consumedAt,
    ).toBeNull();
    expect(await registrationEventsFor(scan.id)).toBe("0");
  });

  it("leaves a request that has waited past its hour to expire", async () => {
    const { db } = getDatabase();
    const { scan } = await createFreshCompletedScan("expired-request");
    const email = "expired-request@example.com";
    await createScannerRegistrationIntent(scan, registrationBody(email));
    const link = latestLink(email);
    await db
      .update(registrationIntents)
      .set({ expiresAt: new Date(Date.now() - 1_000) })
      .where(eq(registrationIntents.id, link.request));

    await expect(visitorOf(pressLink(link))).resolves.toMatchObject({
      kind: "person",
      leadId: null,
    });

    expect(await registrationEventsFor(scan.id)).toBe("0");
    expect(await getFullReport(scan.id, pressLink(link))).toBeUndefined();
  });

  it("files a signed-in person's own ask at once, sends nothing, and leaves a stranger's waiting request alone", async () => {
    // Somebody else asked for this scan's report with this person's address
    // and a marketing choice of their own. The person's own ask, signed in,
    // makes and finishes a request of their own with their own choices, and
    // the stranger's waits until it expires (ADR-0026 §2).
    const { db } = getDatabase();
    const { scan, accessToken } = await createFreshCompletedScan("signed-in-ask");
    await copyChecks(scan.id);
    const email = "signed-in-ask@example.com";
    await createScannerRegistrationIntent(scan, {
      ...registrationBody(email),
      marketing_email_opt_in: true,
    });
    const strangers = latestLink(email);
    const sentBefore = sentLinks.length;
    const cookie = signedInAs(email);
    process.env.REGISTRATION_ENABLED = "true";
    try {
      const forged = await registrationRequest(
        scan.id,
        accessToken,
        { ...registrationBody(email), email: undefined },
        { cookie, origin: "https://foreign.example" },
      );
      expect(forged.status).toBe(403);

      const asked = await registrationRequest(
        scan.id,
        accessToken,
        { ...registrationBody("typed-over@example.com"), marketing_email_opt_in: false },
        { cookie },
      );

      expect(asked.status).toBe(200);
      expect(await asked.json()).toEqual({
        status: "report_ready",
        report_url: `/report/${scan.id}`,
        email,
      });
    } finally {
      process.env.REGISTRATION_ENABLED = "false";
    }
    expect(sentLinks).toHaveLength(sentBefore);
    expect((await getFullReport(scan.id, cookie))?.checks).toHaveLength(18);
    expect(
      onlyRow(
        await db
          .select()
          .from(registrationIntents)
          .where(eq(registrationIntents.id, strangers.request)),
      ).consumedAt,
    ).toBeNull();
    const consent = onlyRow(
      await db
        .select({ categories: consentSnapshots.categories })
        .from(consentSnapshots)
        .innerJoin(sessions, eq(sessions.consentSnapshotId, consentSnapshots.id))
        .where(eq(sessions.id, scan.sessionId)),
    );
    expect(consent.categories).toMatchObject({ marketing_email: false });
    expect(
      await db
        .select()
        .from(leads)
        .where(
          eq(leads.emailLookupHash, hmacHex(tokenHmacSecret, "email", "typed-over@example.com")),
        ),
    ).toHaveLength(0);
  });

  it("refuses a stranger's ask without an address, in words", async () => {
    const { scan, accessToken } = await createFreshCompletedScan("no-address");
    process.env.REGISTRATION_ENABLED = "true";
    try {
      const response = await registrationRequest(scan.id, accessToken, {
        ...registrationBody("unused@example.com"),
        email: undefined,
      });
      expect(response.status).toBe(400);
      expect(((await response.json()) as { error: { message: string } }).error.message).toMatch(
        /email/i,
      );
    } finally {
      process.env.REGISTRATION_ENABLED = "false";
    }
  });

  it("says it cannot tell who is visiting when the cabinet does not answer, and never that nobody is", async () => {
    const { scan, accessToken } = await createFreshCompletedScan("cabinet-down");
    const cookie = signedInAs("cabinet-down@example.com");
    cabinetDown = true;
    process.env.REGISTRATION_ENABLED = "true";
    try {
      await expect(visitorOf(cookie)).resolves.toEqual({ kind: "unknown" });
      const header = await readVisitor(
        new NextRequest("http://localhost:3000/api/v2/session", { headers: { cookie } }),
      );
      expect(header.status).toBe(503);
      expect(await header.json()).toEqual({ status: "unknown" });
      const asked = await registrationRequest(
        scan.id,
        accessToken,
        registrationBody("cabinet-down@example.com"),
        { cookie },
      );
      expect(asked.status).toBe(503);
      expect(sentLinks.some((link) => link.email === "cabinet-down@example.com")).toBe(false);
    } finally {
      cabinetDown = false;
      process.env.REGISTRATION_ENABLED = "false";
    }
  });

  it("answers the header privately and passes the renewed cookie on", async () => {
    const cookie = signedInAs("header@example.com");

    const signedIn = await readVisitor(
      new NextRequest("http://localhost:3000/api/v2/session", { headers: { cookie } }),
    );
    const stranger = await readVisitor(new NextRequest("http://localhost:3000/api/v2/session"));

    expect(signedIn.status).toBe(200);
    expect(await signedIn.json()).toEqual({ status: "signed_in", email: "header@example.com" });
    // An answer carrying an address is never stored by a shared cache.
    expect(signedIn.headers.get("cache-control")).toBe("private, no-store");
    expect(signedIn.headers.getSetCookie().join("\n")).toContain(`${SESSION_COOKIE}=`);
    expect(await stranger.json()).toEqual({ status: "signed_out" });
    expect(stranger.headers.getSetCookie()).toEqual([]);
  });

  it("starts a person with reports at the latest of them, and one without at nothing", async () => {
    const { scan: older } = await createFreshCompletedScan("latest-older");
    const { scan: newer } = await createFreshCompletedScan("latest-newer");
    await getDatabase()
      .db.update(scans)
      .set({ finishedAt: new Date(Date.now() - 86_400_000) })
      .where(eq(scans.id, older.id));
    const email = "latest@example.com";
    for (const scan of [older, newer]) {
      await createScannerRegistrationIntent(scan, registrationBody(email));
      await visitorOf(pressLink(latestLink(email)));
    }

    const person = await visitorOf(signedInAs(email));
    if (person.kind !== "person" || person.leadId === null)
      throw new Error("no lead for the person");
    expect(await latestReportOf(person.leadId)).toBe(newer.id);
    const nobody = await visitorOf(signedInAs("no-reports@example.com"));
    expect(nobody).toMatchObject({ kind: "person", leadId: null });
  });

  it("unlocks a report without a phone and stores none for the lead", async () => {
    const { db } = getDatabase();
    const { scan } = await createFreshCompletedScan("no-phone-registration");
    await copyChecks(scan.id);

    const email = "no-phone@example.com";
    await createScannerRegistrationIntent(scan, { ...registrationBody(email), phone: undefined });
    const link = latestLink(email);
    const emailLookupHash = hmacHex(tokenHmacSecret, "email", email);
    const intent = onlyRow(
      await db.select().from(registrationIntents).where(eq(registrationIntents.id, link.request)),
    );
    expect(intent.phoneE164Ciphertext).toBeNull();
    expect(intent.phoneLookupHash).toBeNull();

    expect((await getFullReport(scan.id, pressLink(link)))?.scan_id).toBe(scan.id);
    const lead = onlyRow(
      await db.select().from(leads).where(eq(leads.emailLookupHash, emailLookupHash)),
    );
    expect(lead.phoneE164Ciphertext).toBeNull();
    expect(lead.phoneLookupHash).toBeNull();
  });

  it("stores phone only encrypted and finishes the request once", async () => {
    const { db } = getDatabase();
    const { scan, accessToken } = await createFreshCompletedScan("encrypted-registration");
    await copyChecks(scan.id);
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
    const firstLink = latestLink(email);
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
    expect(JSON.stringify(activeIntent)).not.toContain("+14155550123");
    expect(JSON.stringify(activeIntent)).not.toContain(partnerClickId);

    await expect(
      createScannerRegistrationIntent(scan, registrationBody(email), {
        partnerClickId,
        sendReportLink: async () => ({ status: "unavailable" }) as const,
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

    const strangerCookie = `${SESSION_COOKIE}=nobody-issued-this`;
    // Signed in with reports of its own, and not this one's.
    const otherOwnerCookie = signedInAs("first-visit@example.com");
    const authorizedCookie = pressLink(firstLink);
    for (const [cookie, status] of [
      [undefined, 401],
      [strangerCookie, 401],
      [otherOwnerCookie, 401],
      [authorizedCookie, 200],
    ] as const) {
      expect(
        (
          await getContactAccess(
            new NextRequest(`http://localhost:3000/api/v2/scans/${scan.id}/contact-access`, {
              headers: cookie ? { cookie } : {},
            }),
            { params: Promise.resolve({ id: scan.id }) },
          )
        ).status,
        String(cookie),
      ).toBe(status);
    }
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
    for (const [cookie, status] of [
      [otherOwnerCookie, 401],
      [authorizedCookie, 200],
    ] as const) {
      expect(
        (
          await getTeaserPrompt(
            new NextRequest(
              `http://localhost:3000/api/v1/scans/${scan.id}/remediation-prompt?scope=teaser`,
              { headers: { cookie } },
            ),
            { params: Promise.resolve({ id: scan.id }) },
          )
        ).status,
        cookie,
      ).toBe(status);
    }
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

    await createScannerRegistrationIntent(scan, registrationBody(email), {
      partnerClickId,
    });
    await visitorOf(pressLink(latestLink(email)));
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
    await expect(visitorOf(pressLink(latestLink(revokedEmail)))).resolves.toMatchObject({
      kind: "person",
    });
    expect(
      await db
        .select()
        .from(deliveryOutbox)
        .where(eq(deliveryOutbox.destination, "partner_tracker")),
    ).toHaveLength(1);
  });

  it("authorizes the 18-row report and a revocable safe share for the owner's session", async () => {
    const scan = onlyRow(
      await getDatabase().db.select().from(scans).where(eq(scans.id, scanId)).limit(1),
    );
    const owner = signedInAs("owner@example.com");
    const report = await getFullReport(scanId, owner);
    expect(report?.checks).toHaveLength(18);
    expect(JSON.stringify(report)).not.toContain("private.example");
    expect(report?.benchmark).toBeNull();
    // Somebody else, signed in, does not own it: neither an address with no
    // reports nor one whose reports are other scans'.
    expect(await getFullReport(scanId, signedInAs("not-the-owner@example.com"))).toBeUndefined();
    expect(await getFullReport(scanId, signedInAs("first-visit@example.com"))).toBeUndefined();
    await expect(visitorOf(signedInAs("first-visit@example.com"))).resolves.toMatchObject({
      kind: "person",
      leadId: expect.any(String),
    });
    expect(scan.id).toBe(scanId);
    const fullDownload = await downloadFullPrompt(
      new NextRequest(
        `http://localhost:3000/api/v1/reports/${scanId}/remediation-prompt/download`,
        { headers: { cookie: owner } },
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
          cookie: owner,
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
    expect(initial.filter((result) => result.verdict === "allowed")).toHaveLength(3);
    expect(initial.filter((result) => result.verdict === "challenge_required")).toHaveLength(2);
    expect(await readRateCount(ipKey, "scan_ip_hour")).toBe(3);
    expect(await readRateCount(targetKey, "scan_target_day")).toBe(3);

    const challenged = await Promise.all(
      Array.from({ length: 7 }, () =>
        consumeScanRateLimits({ ipKey, targetKey, challengePassed: true }),
      ),
    );
    expect(challenged.every((result) => result.verdict === "allowed")).toBe(true);
    const untouchedTarget = `rate-untouched-${suffix}`;
    expect(
      await consumeScanRateLimits({
        ipKey,
        targetKey: untouchedTarget,
        challengePassed: true,
      }),
    ).toMatchObject({ verdict: "hard_rate_limit" });
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
      ).resolves.toEqual({ verdict: "allowed" });
    }
    const afterBoundary = new Date("2026-07-12T01:00:01.000Z");
    await expect(
      consumeScanRateLimits({
        ipKey,
        targetKey,
        challengePassed: false,
        now: afterBoundary,
      }),
    ).resolves.toEqual({ verdict: "challenge_required" });
    expect(await readRateCount(ipKey, "scan_ip_hour", afterBoundary)).toBe(3);

    const afterRollingExpiry = new Date("2026-07-12T02:00:00.001Z");
    await expect(
      consumeScanRateLimits({
        ipKey,
        targetKey,
        challengePassed: false,
        now: afterRollingExpiry,
      }),
    ).resolves.toEqual({ verdict: "allowed" });
    expect(await readRateCount(ipKey, "scan_ip_hour", afterRollingExpiry)).toBe(1);
  });

  it("names the moment a full rolling hour frees up rather than a flat hour", async () => {
    const entry = {
      keyHash: `rolling-wait-${createUuidV7()}`,
      kind: "registration_email_hour" as const,
      limit: 3,
    };
    const now = new Date("2026-07-12T12:00:00.000Z");
    for (const minutesAgo of [50, 40, 30]) {
      await expect(
        consumeRateLimitsAtomically([entry], new Date(now.getTime() - minutesAgo * 60_000)),
      ).resolves.toMatchObject({ allowed: true });
    }

    const refused = await consumeRateLimitsAtomically([entry], now);

    expect(refused.allowed).toBe(false);
    // The oldest of the three leaves the hour ten minutes from now.
    expect(refused.allowed === false && refused.retryAt.toISOString()).toBe(
      new Date(now.getTime() + 10 * 60_000).toISOString(),
    );
  });

  it("reads an over-full window off the event that keeps it full", async () => {
    const keyHash = `over-full-${createUuidV7()}`;
    const now = new Date("2026-07-12T12:00:00.000Z");
    for (const minutesAgo of [55, 50, 45, 40, 35]) {
      await expect(
        consumeRateLimitsAtomically(
          [{ keyHash, kind: "registration_email_hour" as const, limit: 99 }],
          new Date(now.getTime() - minutesAgo * 60_000),
        ),
      ).resolves.toMatchObject({ allowed: true });
    }

    const refused = await consumeRateLimitsAtomically(
      [{ keyHash, kind: "registration_email_hour" as const, limit: 3 }],
      now,
    );

    // Five events, three allowed: the window frees when the third-newest goes,
    // which is fifteen minutes out — not when the oldest of the five does.
    expect(refused.allowed).toBe(false);
    expect(refused.allowed === false && refused.retryAt.toISOString()).toBe(
      new Date(now.getTime() + 15 * 60_000).toISOString(),
    );
  });

  it("names the wall still standing when the nearer one has gone", async () => {
    const suffix = createUuidV7();
    const now = new Date("2026-07-12T12:00:00.000Z");
    const email = {
      keyHash: `near-wall-${suffix}`,
      kind: "registration_email_hour" as const,
      limit: 1,
    };
    const session = {
      keyHash: `far-wall-${suffix}`,
      kind: "registration_session_hour" as const,
      limit: 1,
    };
    await consumeRateLimitsAtomically([email], new Date(now.getTime() - 50 * 60_000));
    await consumeRateLimitsAtomically([session], new Date(now.getTime() - 20 * 60_000));

    const refused = await consumeRateLimitsAtomically([email, session], now);

    expect(refused.allowed).toBe(false);
    expect(refused.allowed === false && refused.retryAt.toISOString()).toBe(
      new Date(now.getTime() + 40 * 60_000).toISOString(),
    );
  });

  it("names when the scan wall frees instead of a flat hour", async () => {
    const suffix = createUuidV7();
    const ipKey = `hard-wait-ip-${suffix}`;
    const now = new Date("2026-07-12T12:00:00.000Z");
    const filled = new Date(now.getTime() - 50 * 60_000);
    for (let scan = 0; scan < 10; scan += 1) {
      await expect(
        consumeScanRateLimits({
          ipKey,
          targetKey: `hard-wait-target-${suffix}-${scan}`,
          challengePassed: true,
          now: filled,
        }),
      ).resolves.toEqual({ verdict: "allowed" });
    }

    await expect(
      consumeScanRateLimits({
        ipKey,
        targetKey: `hard-wait-target-${suffix}-fresh`,
        challengePassed: true,
        now,
      }),
    ).resolves.toEqual({
      verdict: "hard_rate_limit",
      retryAt: new Date(now.getTime() + 10 * 60_000),
    });
  });

  it("names the day a target's own wall rolls over", async () => {
    const suffix = createUuidV7();
    const targetKey = `day-wall-target-${suffix}`;
    const now = new Date("2026-07-12T09:30:00.000Z");
    for (let scan = 0; scan < 10; scan += 1) {
      await expect(
        consumeScanRateLimits({
          ipKey: `day-wall-ip-${suffix}-${scan}`,
          targetKey,
          challengePassed: true,
          now,
        }),
      ).resolves.toEqual({ verdict: "allowed" });
    }

    await expect(
      consumeScanRateLimits({
        ipKey: `day-wall-ip-${suffix}-fresh`,
        targetKey,
        challengePassed: true,
        now,
      }),
    ).resolves.toEqual({
      verdict: "hard_rate_limit",
      retryAt: new Date("2026-07-13T00:00:00.000Z"),
    });
  });

  it("tells a refused scan when its own wall frees, not a flat hour", async () => {
    const ip = "203.0.113.99";
    const ipKey = hmacHex(tokenHmacSecret, "rate-ip", ip);
    const filled = new Date(Date.now() - 50 * 60_000);
    for (let scan = 0; scan < 10; scan += 1) {
      await expect(
        consumeRateLimitsAtomically(
          [{ keyHash: ipKey, kind: "scan_ip_hour" as const, limit: 99 }],
          filled,
        ),
      ).resolves.toMatchObject({ allowed: true });
    }

    const response = await acceptScan(
      new NextRequest("http://localhost:3000/api/v1/scans", {
        method: "POST",
        headers: {
          origin: "http://localhost:3000",
          "content-type": "application/json",
          "idempotency-key": `hard-wall-${createUuidV7()}`,
          "x-forwarded-for": ip,
        },
        body: JSON.stringify({
          url: "https://hard-wall.example/",
          segment: "owner",
          landing_variant: "owner-v1",
          turnstile_token: null,
        }),
      }),
    );

    expect(response.status).toBe(429);
    const refusal = (await response.json()) as {
      error: { code: string; retry_after_seconds?: number };
    };
    const seconds = refusal.error.retry_after_seconds;
    expect(refusal.error.code).toBe("hard_rate_limit");
    // The wall was filled fifty minutes ago, so it frees in ten.
    expect(seconds).toBeGreaterThan(9 * 60);
    expect(seconds).toBeLessThanOrEqual(10 * 60);
    expect(response.headers.get("Retry-After")).toBe(String(seconds));
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
    const firstLink = latestLink(email);
    let markSending!: () => void;
    let releaseSending!: () => void;
    const sending = new Promise<void>((resolve) => {
      markSending = resolve;
    });
    const continueSending = new Promise<void>((resolve) => {
      releaseSending = resolve;
    });
    const lateRequest = createScannerRegistrationIntent(scan, registrationBody(email), {
      sendReportLink: async (address, request) => {
        markSending();
        await continueSending;
        return await getCabinetReportIdentityClient().sendReportLink({
          email: address,
          scanId: scan.id,
          request,
        });
      },
    });
    await sending;
    await expect(requestScannerIdentityDeletion({ leadId })).resolves.toBe("completed");
    releaseSending();
    await expect(lateRequest).rejects.toThrow("registration_scan_unavailable");
    // The earlier link pressed after the deletion finishes nothing: its
    // request went with the address, and the reports are gone.
    await visitorOf(pressLink(firstLink));
    expect(
      await db
        .select()
        .from(registrationIntents)
        .where(eq(registrationIntents.id, firstLink.request)),
    ).toHaveLength(0);
    expect((await db.select().from(scans).where(eq(scans.id, scan.id)))[0]?.leadId).toBeNull();
    expect((await db.select().from(leads).where(eq(leads.id, leadId)))[0]?.role).toBe("deleted");
  });

  it("keeps an admitted link good when the scan bearer expires during delivery", async () => {
    const { db } = getDatabase();
    const { scan } = await createFreshCompletedScan("bearer-expiry");
    const email = "scanner-bearer-expiry@example.com";
    const result = await createScannerRegistrationIntent(scan, registrationBody(email), {
      sendReportLink: async (address, request) => {
        const sent = await getCabinetReportIdentityClient().sendReportLink({
          email: address,
          scanId: scan.id,
          request,
        });
        await db
          .update(scans)
          .set({ accessTokenExpiresAt: new Date(Date.now() - 1_000) })
          .where(eq(scans.id, scan.id));
        return sent;
      },
    });
    expect(result.sent).toBe(true);
    await visitorOf(pressLink(latestLink(email)));
    expect(await db.select().from(leadScans).where(eq(leadScans.scanId, scan.id))).toHaveLength(1);
  });

  it("serializes finishing a request with deletion and leaves the scan anonymized", async () => {
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
    const link = latestLink(email);
    await admin.pool.query(`create function hold_finishing_for_deletion() returns trigger
      language plpgsql as $$ begin
        if new.lead_id = '${leadId}'::uuid then perform pg_advisory_xact_lock(479926); end if;
        return new;
      end $$`);
    await admin.pool.query(`create trigger hold_finishing_for_deletion before insert
      on waitlist_entries for each row execute function hold_finishing_for_deletion()`);
    const blocker = await admin.pool.connect();
    await blocker.query("begin");
    await blocker.query("select pg_advisory_xact_lock(479926)");
    let confirmation: ReturnType<typeof visitorOf> | undefined;
    let deletion: ReturnType<typeof requestScannerIdentityDeletion> | undefined;
    try {
      confirmation = visitorOf(pressLink(link));
      let confirmationBlocked = false;
      for (let attempt = 0; attempt < 30; attempt += 1) {
        const state = await pool.query<{ count: number }>(
          `select count(*)::int as count from pg_stat_activity
           where datname = current_database() and wait_event_type = 'Lock'
             and query like '%waitlist_entries%'`,
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
      await admin.pool.query("drop trigger hold_finishing_for_deletion on waitlist_entries");
      await admin.pool.query("drop function hold_finishing_for_deletion() ");
    }
    if (!confirmation || !deletion)
      throw new Error("the blocked confirmation and deletion never started");
    expect(await confirmation).toMatchObject({ kind: "person" });
    await expect(deletion).resolves.toBe("completed");
    const after = onlyRow(await db.select().from(scans).where(eq(scans.id, scan.id)));
    expect(after.leadId).toBeNull();
    expect(after.sessionId).not.toBe(scan.sessionId);
    expect(after.submittedUrlRedacted).toBe("redacted://deleted");
  });

  it("serializes another address finishing with deletion of the scan's old owner", async () => {
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
    const link = latestLink(newEmail);
    await admin.pool.query(`create function hold_cross_email_finishing() returns trigger
      language plpgsql as $$ begin perform pg_advisory_xact_lock(479927); return new; end $$`);
    await admin.pool.query(`create trigger hold_cross_email_finishing before insert
      on waitlist_entries for each row execute function hold_cross_email_finishing()`);
    const blocker = await admin.pool.connect();
    await blocker.query("begin");
    await blocker.query("select pg_advisory_xact_lock(479927)");
    let confirmation: ReturnType<typeof visitorOf> | undefined;
    let deletion: ReturnType<typeof requestScannerIdentityDeletion> | undefined;
    try {
      confirmation = visitorOf(pressLink(link));
      let confirmationBlocked = false;
      for (let attempt = 0; attempt < 30; attempt += 1) {
        const state = await pool.query<{ count: number }>(
          `select count(*)::int as count from pg_stat_activity
           where datname = current_database() and wait_event_type = 'Lock'
             and query like '%waitlist_entries%'`,
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
      await admin.pool.query("drop trigger hold_cross_email_finishing on waitlist_entries");
      await admin.pool.query("drop function hold_cross_email_finishing()");
    }
    if (!confirmation || !deletion)
      throw new Error("the blocked confirmation and deletion never started");
    expect(await confirmation).toMatchObject({ kind: "person" });
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
      expect(await response.clone().text()).not.toContain("verification_sent");
      const refusal = (await response.json()) as {
        error: { message: string; retry_after_seconds?: number };
      };
      expect(refusal.error.retry_after_seconds).toBeGreaterThan(0);
      expect(refusal.error.retry_after_seconds).toBeLessThanOrEqual(3600);
      expect(response.headers.get("Retry-After")).toBe(String(refusal.error.retry_after_seconds));
    } finally {
      process.env.REGISTRATION_ENABLED = "false";
    }
  });

  it("keeps the address's hour for the letters that actually went out", async () => {
    const { scan } = await createFreshCompletedScan("cooldown-refund");
    const email = "scanner-cooldown-refund@example.com";
    const body = registrationBody(email);
    const addressWall = hmacHex(
      tokenHmacSecret,
      "registration-email",
      hmacHex(tokenHmacSecret, "email", email),
    );
    const sessionWall = hmacHex(tokenHmacSecret, "registration-session", scan.sessionId);
    await expect(createScannerRegistrationIntent(scan, body)).resolves.toMatchObject({
      sent: true,
    });

    sendCooldownUntil = new Date(Date.now() + 40_000);
    try {
      for (let ask = 0; ask < 2; ask += 1) {
        await expect(createScannerRegistrationIntent(scan, body)).resolves.toMatchObject({
          sent: false,
        });
      }
    } finally {
      sendCooldownUntil = undefined;
    }

    // Nothing reached the mailbox on those two, so the address keeps its hour.
    expect(await readRateCount(addressWall, "registration_email_hour")).toBe(1);
    // The requests reached us, and the session wall counts requests.
    expect(await readRateCount(sessionWall, "registration_session_hour")).toBe(3);
    // Somebody who waits out the wait they were told still has their links.
    await expect(createScannerRegistrationIntent(scan, body)).resolves.toMatchObject({
      sent: true,
    });
    expect(await readRateCount(addressWall, "registration_email_hour")).toBe(2);
  });

  it("keeps the hour spent when it cannot prove no letter went out", async () => {
    const { scan } = await createFreshCompletedScan("unconfirmed-send");
    const email = "scanner-unconfirmed-send@example.com";
    const addressWall = hmacHex(
      tokenHmacSecret,
      "registration-email",
      hmacHex(tokenHmacSecret, "email", email),
    );

    await expect(
      createScannerRegistrationIntent(scan, registrationBody(email), {
        sendReportLink: async () => ({ status: "unavailable" }) as const,
      }),
    ).rejects.toThrow("cabinet_identity_unavailable");

    // Refused and timed out look the same from here, and a timed-out message
    // may well have been delivered: nothing is given back on a guess.
    expect(await readRateCount(addressWall, "registration_email_hour")).toBe(1);
  });

  it("passes the cabinet's own wait through the registration door untouched", async () => {
    const { scan, accessToken } = await createFreshCompletedScan("cabinet-cooldown");
    const body = registrationBody("scanner-cabinet-cooldown@example.com");
    process.env.REGISTRATION_ENABLED = "true";
    sendCooldownUntil = new Date(Date.now() + 40_000);
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
      const refusal = (await response.json()) as {
        error: { message: string; retry_after_seconds?: number };
      };
      const seconds = refusal.error.retry_after_seconds;
      expect(seconds).toBeGreaterThan(30);
      expect(seconds).toBeLessThanOrEqual(40);
      expect(response.headers.get("Retry-After")).toBe(String(seconds));
      expect(refusal.error.message).toContain(`${seconds} seconds`);
      expect(refusal.error.message).not.toMatch(/hour|too many/i);
    } finally {
      sendCooldownUntil = undefined;
      process.env.REGISTRATION_ENABLED = "false";
    }
  });
});
