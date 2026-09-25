/**
 * A deterministic local report for the browser smoke, and a way to sign in to it.
 *
 * The scanner keeps no session (ADR-0026 §2), so the smoke signs in the way a
 * person does: through the cabinet's page with one control. What this plants
 * in the cabinet's database is exactly what the cabinet writes when the scanner
 * asks it for a link, a hashed one-time token with its address and
 * destination, because the message itself goes to the cabinet's log and a
 * browser script cannot read that. Local databases only.
 */

import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chmod, writeFile } from "node:fs/promises";

import {
  BROWSER_OBSERVATION_VERSION,
  browserObservationIdSchema,
  CHECK_DEFINITIONS,
} from "@agentify/scanner-contracts";
import {
  browserObservationFindings,
  browserObservations,
  consentSnapshots,
  createDatabase,
  createUuidV7,
  leadScans,
  leads,
  scanChecks,
  scans,
  sessions,
  waitlistEntries,
} from "@agentify/scanner-database";
import { eq } from "drizzle-orm";
import { getServerConfig } from "../lib/server/config";
import { encryptEmail, hmacHex, sha256 } from "../lib/server/crypto";
import { getDatabase } from "../lib/server/database";

if (process.env.LOCAL_E2E_FIXTURE_ACK !== "yes")
  throw new Error("LOCAL_E2E_FIXTURE_ACK=yes is required");
const databaseUrl = new URL(process.env.DATABASE_URL ?? "");
if (!["localhost", "127.0.0.1"].includes(databaseUrl.hostname))
  throw new Error("Local E2E fixture refuses a non-local database");
const outputFileInput = process.env.LOCAL_E2E_VERIFICATION_FILE;
if (!outputFileInput?.startsWith("/tmp/"))
  throw new Error("LOCAL_E2E_VERIFICATION_FILE must be under /tmp");
const outputFile = outputFileInput;
const cabinetDatabaseUrl = new URL(process.env.CABINET_DATABASE_URL ?? "");
if (!["localhost", "127.0.0.1"].includes(cabinetDatabaseUrl.hostname))
  throw new Error("Local E2E fixture refuses a non-local CABINET_DATABASE_URL");

/** A one-time link for this address to this report, written the way the cabinet writes one. */
async function plantSignInLink(email: string, scanId: string): Promise<string> {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const token = [...randomBytes(32)].map((byte) => alphabet[byte % alphabet.length]).join("");
  const cabinet = createDatabase(cabinetDatabaseUrl.toString(), { max: 1 });
  try {
    const now = new Date();
    await cabinet.pool.query(
      `insert into cabinet_verifications (id, identifier, value, expires_at, created_at, updated_at)
       values ($1, $2, $3, $4, $5, $5)`,
      [
        randomUUID(),
        createHash("sha256").update(token).digest("base64url"),
        JSON.stringify({ email, destination: { report: scanId }, request: null }),
        new Date(now.getTime() + 60 * 60 * 1_000),
        now,
      ],
    );
  } finally {
    await cabinet.pool.end();
  }
  return token;
}
async function main() {
  const { db, pool } = getDatabase();
  const config = getServerConfig();
  try {
    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const sessionId = createUuidV7();
    const consentId = createUuidV7();
    const scanId = createUuidV7();
    const browserObservationId = createUuidV7();
    const browserOperationId = createUuidV7();
    const leadId = createUuidV7();
    const accessToken = `local-e2e-access-${suffix}`;
    const email = `local-e2e-${suffix}@example.com`;
    await db.insert(sessions).values({
      id: sessionId,
      anonymousIdHash: `local-e2e-${suffix}`,
      firstLandingVariant: "owner-v1",
    });
    await db.insert(consentSnapshots).values({
      id: consentId,
      sessionId,
      policyVersion: "consent-v1.0.0",
      categories: {
        essential_processing: true,
        product_analytics: false,
        ads_measurement: false,
        marketing_email: false,
        dataset_reuse: true,
        card_signal: false,
      },
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
      submittedUrlRedacted: `https://local-evidence-${suffix}.example/`,
      canonicalTargetUrl: `https://local-evidence-${suffix}.example/`,
      targetHost: `local-evidence-${suffix}.example`,
      targetHash: `local-e2e-target-${suffix}`,
      status: "completed",
      score: 82,
      coverage: "1.000",
      level: "callable_ready",
      applicableWeight: "100",
      earnedWeight: "82",
      finishedAt: new Date(),
      accessTokenHash: sha256(accessToken),
      accessTokenExpiresAt: new Date(Date.now() + 86_400_000),
      idempotencyKeyHash: `local-e2e-idem-${suffix}`,
      idempotencyBodyHash: `local-e2e-body-${suffix}`,
    });
    await db.insert(scanChecks).values(
      CHECK_DEFINITIONS.map((check) => ({
        scanId,
        checkId: check.id,
        status:
          check.id === 6
            ? ("fail" as const)
            : check.id === 12
              ? ("partial" as const)
              : check.id === 8 || check.id === 17
                ? ("not_applicable" as const)
                : ("pass" as const),
        nominalWeight: String(check.nominalWeight),
        applicableWeight: String(check.nominalWeight),
        earnedWeight: String(
          check.id === 6 ? 0 : check.id === 12 ? check.nominalWeight / 2 : check.nominalWeight,
        ),
        summaryCode: `${check.labelCode}_observed`,
        userImpactCode: `${check.labelCode}_impact`,
        fixCode: `${check.labelCode}_fix`,
        durationMs: 5,
        evidence: { local_deterministic_fixture: true },
      })),
    );
    await db.insert(browserObservations).values({
      id: browserObservationId,
      scanId,
      observationVersion: BROWSER_OBSERVATION_VERSION,
      operationId: browserOperationId,
      operationKey: `${scanId}:${BROWSER_OBSERVATION_VERSION}`,
      status: "completed",
      actorId: "local-fixture",
      actorBuild: "local-e2e-v1",
      startedAt: new Date(),
      finishedAt: new Date(),
      lastPolledAt: new Date(),
      pagesAssessed: 2,
      requestCount: 24,
      transferredBytes: 345_678,
      durationMs: 1_250,
      usageUsd: "0.001000",
      signals: {
        rendered_text_chars: 8_200,
        raw_to_rendered_ratio: 1.4,
        landmark_counts: { main: 1, navigation: 1 },
        heading_level_counts: { h1: 1, h2: 4 },
        interactive_control_count: 12,
        unnamed_control_count: 2,
        form_control_count: 4,
        unlabeled_form_control_count: 1,
        webmcp_present: false,
        webmcp_tool_count: 0,
        console_error_categories: ["network"],
        failed_resource_categories: ["image"],
        mixed_content_count: 0,
        dom_node_count: 460,
        script_count: 8,
        request_count: 24,
        transferred_bytes: 345_678,
        challenge_kind: null,
      },
    });
    await db.insert(browserObservationFindings).values(
      browserObservationIdSchema.options.map((findingId) => {
        const failed = new Set([
          "accessibility_structure",
          "form_semantics",
          "browser_network_health",
        ]).has(findingId);
        return {
          observationId: browserObservationId,
          findingId,
          status: failed ? ("fail" as const) : ("pass" as const),
          summaryCode: `${findingId}_${failed ? "needs_improvement" : "healthy"}`,
          userImpactCode: `${findingId}_agent_impact`,
          remediationCode: failed ? `${findingId}_remediation` : null,
          evidence: { observed_count: failed ? 2 : 0 },
          durationMs: 10,
        };
      }),
    );
    await db.insert(leads).values({
      id: leadId,
      emailNormalizedCiphertext: encryptEmail(email, config.encryptionKey),
      emailLookupHash: hmacHex(config.hmacSecret, "email", email),
      phoneE164Ciphertext: `local-phone-encrypted-${suffix}`,
      phoneLookupHash: `local-phone-hash-${suffix}`,
      role: "business_owner",
      verifiedAt: new Date(),
      firstSegment: "owner",
      firstSessionId: sessionId,
    });
    await db.insert(leadScans).values({
      leadId,
      scanId,
      siteOwnershipClaim: true,
    });
    await db.update(scans).set({ leadId }).where(eq(scans.id, scanId));
    await db.insert(waitlistEntries).values({
      id: createUuidV7(),
      leadId,
      scanId,
    });
    const baseUrl = process.env.APP_BASE_URL ?? "http://localhost:3000";
    const signInToken = await plantSignInLink(email, scanId);
    await writeFile(
      outputFile,
      JSON.stringify({
        scanUrl: `${baseUrl}/scan/${scanId}?segment=owner#access_token=${accessToken}`,
        reportUrl: `${baseUrl}/report/${scanId}`,
        signInUrl: `${baseUrl}/cabinet/sign-in/open?token=${signInToken}`,
        email,
      }),
      { mode: 0o600 },
    );
    await chmod(outputFile, 0o600);
    process.stdout.write("Local deterministic browser fixture ready.\n");
  } finally {
    await pool.end();
  }
}

void main().catch((error: unknown) => {
  process.stderr.write(
    `Local E2E fixture failed: ${error instanceof Error ? error.message : "unknown_error"}\n`,
  );
  process.exitCode = 1;
});
