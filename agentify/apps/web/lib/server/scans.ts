import {
  CHECK_DEFINITIONS,
  SCAN_RUBRIC_VERSION,
  BROWSER_OBSERVATION_VERSION,
  type BrowserObservationStatusResponse,
  type CreateScanRequest,
  type ScanStatusResponse,
} from "@b2a/contracts";
import {
  consentSnapshots,
  createBrowserObservationRepository,
  createUuidV7,
  emitStoredBusinessEvent,
  scanChecks,
  scans,
  sessions,
} from "@b2a/db";
import { canonicalizeTarget, selectFindings } from "@b2a/scanner-core";
import { and, eq, sql } from "drizzle-orm";

import { getVerifiedSession } from "./auth";
import { getServerConfig } from "./config";
import { deriveCapability, hmacHex, sha256 } from "./crypto";
import { getDatabase } from "./database";
import { enqueueScanInTransaction, getScanQueue } from "./queue";

export const ANONYMOUS_COOKIE = "b2a_anonymous";

type ScanCreation = {
  scanId: string;
  accessToken: string;
  anonymousToken?: string;
  conflict: boolean;
};

function canonicalizeSubmittedUrl(value: string): {
  canonical: string;
  redacted: string;
  host: string;
} {
  const url = canonicalizeTarget(value);
  const redacted = new URL(url);
  redacted.search = "";
  return {
    canonical: url.toString(),
    redacted: redacted.toString(),
    host: url.hostname,
  };
}

function scanBodyHash(
  body: CreateScanRequest,
  submittedWithoutScheme: boolean,
): string {
  const normalized = canonicalizeSubmittedUrl(body.url);
  return sha256(
    JSON.stringify({
      url: normalized.canonical,
      segment: body.segment,
      landing_variant: body.landing_variant,
      submitted_without_scheme: submittedWithoutScheme,
    }),
  );
}

function legacyScanBodyHash(body: CreateScanRequest): string {
  const normalized = canonicalizeSubmittedUrl(body.url);
  return sha256(
    JSON.stringify({
      url: normalized.canonical,
      segment: body.segment,
      landing_variant: body.landing_variant,
    }),
  );
}

function scanBodyMatches(
  storedHash: string,
  body: CreateScanRequest,
  submittedWithoutScheme: boolean,
): boolean {
  if (storedHash === scanBodyHash(body, submittedWithoutScheme)) return true;
  return !submittedWithoutScheme && storedHash === legacyScanBodyHash(body);
}

export async function lookupScanReplay(
  body: CreateScanRequest,
  idempotencyKey: string,
  anonymousToken: string | undefined,
  submittedWithoutScheme = false,
) {
  if (!anonymousToken) return undefined;
  const config = getServerConfig();
  const { db } = getDatabase();
  const anonymousHash = hmacHex(config.hmacSecret, "anonymous", anonymousToken);
  const session = (
    await db
      .select()
      .from(sessions)
      .where(eq(sessions.anonymousIdHash, anonymousHash))
      .limit(1)
  )[0];
  if (!session) return undefined;
  const idempotencyHash = hmacHex(
    config.hmacSecret,
    "idempotency",
    idempotencyKey,
  );
  const existing = (
    await db
      .select()
      .from(scans)
      .where(
        and(
          eq(scans.sessionId, session.id),
          eq(scans.idempotencyKeyHash, idempotencyHash),
        ),
      )
      .limit(1)
  )[0];
  if (!existing) return undefined;
  return {
    scanId: existing.id,
    accessToken: deriveCapability(
      config.hmacSecret,
      "scan-access",
      session.id,
      idempotencyHash,
    ),
    conflict: !scanBodyMatches(
      existing.idempotencyBodyHash,
      body,
      submittedWithoutScheme,
    ),
    status: existing.status,
  };
}

export async function createOrReplayScan(
  body: CreateScanRequest,
  idempotencyKey: string,
  anonymousToken: string | undefined,
  submittedWithoutScheme = false,
): Promise<ScanCreation> {
  const config = getServerConfig();
  const { db } = getDatabase();
  const normalized = canonicalizeSubmittedUrl(body.url);
  const bodyHash = scanBodyHash(body, submittedWithoutScheme);
  const idempotencyHash = hmacHex(
    config.hmacSecret,
    "idempotency",
    idempotencyKey,
  );
  const suppliedAnonymousHash = anonymousToken
    ? hmacHex(config.hmacSecret, "anonymous", anonymousToken)
    : undefined;

  // Queue initialization is intentionally outside the business transaction.
  // No accepted scan can be persisted if pg-boss is unavailable.
  await getScanQueue();

  const result = await db.transaction(async (tx) => {
    let session = suppliedAnonymousHash
      ? (
          await tx
            .select()
            .from(sessions)
            .where(eq(sessions.anonymousIdHash, suppliedAnonymousHash))
            .limit(1)
        )[0]
      : undefined;
    let newAnonymousToken: string | undefined;
    if (!session) {
      newAnonymousToken =
        crypto.randomUUID().replaceAll("-", "") +
        crypto.randomUUID().replaceAll("-", "");
      const sessionId = createUuidV7();
      const consentId = createUuidV7();
      const anonymousHash = hmacHex(
        config.hmacSecret,
        "anonymous",
        newAnonymousToken,
      );
      await tx.insert(sessions).values({
        id: sessionId,
        anonymousIdHash: anonymousHash,
        firstLandingVariant: body.landing_variant,
        lastLandingVariant: body.landing_variant,
      });
      await tx.insert(consentSnapshots).values({
        id: consentId,
        sessionId,
        policyVersion: "phase-a-v1",
        categories: {
          essential_processing: true,
          product_analytics: false,
          ads_measurement: false,
          marketing_email: false,
          dataset_reuse: false,
          card_signal: false,
        },
        source: "scan_submit",
      });
      await tx
        .update(sessions)
        .set({ consentSnapshotId: consentId })
        .where(eq(sessions.id, sessionId));
      session = (
        await tx
          .select()
          .from(sessions)
          .where(eq(sessions.id, sessionId))
          .limit(1)
      )[0];
    }
    if (!session?.consentSnapshotId) throw new Error("session_consent_missing");
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`${session.id}:${idempotencyHash}`}, 0))`,
    );
    await tx
      .update(sessions)
      .set({
        firstLandingVariant:
          session.firstLandingVariant ?? body.landing_variant,
        lastLandingVariant: body.landing_variant,
        lastSeenAt: new Date(),
      })
      .where(eq(sessions.id, session.id));

    const existing = (
      await tx
        .select()
        .from(scans)
        .where(
          and(
            eq(scans.sessionId, session.id),
            eq(scans.idempotencyKeyHash, idempotencyHash),
          ),
        )
        .limit(1)
    )[0];
    const accessToken = deriveCapability(
      config.hmacSecret,
      "scan-access",
      session.id,
      idempotencyHash,
    );
    if (existing) {
      const conflict = !scanBodyMatches(
        existing.idempotencyBodyHash,
        body,
        submittedWithoutScheme,
      );
      if (!conflict && existing.status === "accepted") {
        await enqueueScanInTransaction(tx, {
          scanId: existing.id,
          canonicalTargetUrl: existing.canonicalTargetUrl,
          submittedWithoutScheme: existing.submittedWithoutScheme,
          segment: existing.segment,
        });
      }
      return {
        scanId: existing.id,
        accessToken,
        anonymousToken: newAnonymousToken,
        conflict,
      };
    }

    const scanId = createUuidV7();
    await tx.insert(scans).values({
      id: scanId,
      sessionId: session.id,
      segment: body.segment,
      rubricVersion: SCAN_RUBRIC_VERSION,
      submittedUrlRedacted: normalized.redacted,
      canonicalTargetUrl: normalized.canonical,
      submittedWithoutScheme,
      targetHost: normalized.host,
      targetHash: hmacHex(config.hmacSecret, "target", normalized.canonical),
      accessTokenHash: sha256(accessToken),
      accessTokenExpiresAt: new Date(Date.now() + 7 * 86_400_000),
      idempotencyKeyHash: idempotencyHash,
      idempotencyBodyHash: bodyHash,
    });
    await emitStoredBusinessEvent(tx, {
      name: "scan_started",
      identifiers: { scan_id: scanId },
      sessionId: session.id,
      consentSnapshotId: session.consentSnapshotId,
      scanId,
      segment: body.segment,
      landingVariant: body.landing_variant,
      properties: { challenge_used: Boolean(body.turnstile_token) },
    });
    await enqueueScanInTransaction(tx, {
      scanId,
      canonicalTargetUrl: normalized.canonical,
      submittedWithoutScheme,
      segment: body.segment,
    });
    return {
      scanId,
      accessToken,
      anonymousToken: newAnonymousToken,
      conflict: false,
    };
  });
  return result;
}

export async function authorizeScan(scanId: string, token: string) {
  const { db } = getDatabase();
  return (
    await db
      .select()
      .from(scans)
      .where(
        and(
          eq(scans.id, scanId),
          eq(scans.accessTokenHash, sha256(token)),
          sql`${scans.accessTokenExpiresAt} > now()`,
        ),
      )
      .limit(1)
  )[0];
}

export async function getScanStatus(
  scanId: string,
  token: string,
): Promise<ScanStatusResponse | undefined> {
  const scan = await authorizeScan(scanId, token);
  if (!scan) return undefined;
  return await buildScanStatus(scan);
}

export async function getScanStatusForVerifiedSession(
  scanId: string,
  sessionToken: string | undefined,
): Promise<ScanStatusResponse | undefined> {
  if (!(await getVerifiedSession(sessionToken, scanId))) return undefined;
  const { db } = getDatabase();
  const scan = (
    await db.select().from(scans).where(eq(scans.id, scanId)).limit(1)
  )[0];
  return scan ? await buildScanStatus(scan) : undefined;
}

async function buildScanStatus(
  scan: typeof scans.$inferSelect,
): Promise<ScanStatusResponse> {
  const { db } = getDatabase();
  const rows = await db
    .select()
    .from(scanChecks)
    .where(eq(scanChecks.scanId, scan.id));
  const byId = new Map(rows.map((row) => [row.checkId, row]));
  const checks = CHECK_DEFINITIONS.map((definition) => {
    const row = byId.get(definition.id);
    return {
      id: definition.id,
      label_code: definition.labelCode,
      status: row?.status ?? "pending",
    };
  });
  const completed = checks.filter(
    ({ status }) => !["pending", "running"].includes(status),
  ).length;
  const terminal = scan.status === "completed" || scan.status === "partial";
  const parsedResults = rows.flatMap((row) => {
    if (
      !["pass", "partial", "fail", "unavailable", "not_applicable"].includes(
        row.status,
      )
    )
      return [];
    return [
      {
        id: row.checkId as (typeof CHECK_DEFINITIONS)[number]["id"],
        status: row.status as
          "pass" | "partial" | "fail" | "unavailable" | "not_applicable",
        nominalWeight: Number(row.nominalWeight),
        applicableWeight: Number(row.applicableWeight),
        earnedWeight: Number(row.earnedWeight),
        summaryCode: row.summaryCode ?? `check_${row.checkId}`,
        evidence: {},
        userImpactCode: row.userImpactCode ?? "methodology_context",
        ...(row.fixCode ? { fixCode: row.fixCode } : {}),
        durationMs: row.durationMs ?? 0,
        ...(row.errorCode ? { errorCode: row.errorCode } : {}),
      },
    ];
  });
  const findings = selectFindings(scan.segment, parsedResults);
  const resultById = new Map(rows.map((row) => [row.checkId, row]));
  return {
    status: scan.status,
    progress: { completed, total: 18 },
    checks,
    updated_at: (
      scan.finishedAt ??
      scan.workerHeartbeatAt ??
      scan.queuedAt ??
      scan.acceptedAt
    ).toISOString(),
    target_host: scan.targetHost,
    ...(terminal && scan.coverage !== null && scan.level
      ? {
          teaser: {
            score: scan.score,
            coverage: Number(scan.coverage),
            level: scan.level,
            top_findings: findings.negativeCheckIds.map(
              (id) => resultById.get(id)?.summaryCode ?? `check_${id}`,
            ),
            positive: findings.positiveCheckId
              ? (resultById.get(findings.positiveCheckId)?.summaryCode ?? null)
              : null,
            hidden_count: Math.max(
              0,
              parsedResults.filter(
                ({ status }) => status === "fail" || status === "partial",
              ).length - findings.negativeCheckIds.length,
            ),
          },
        }
      : {}),
  };
}

function publicBrowserStatus(
  status:
    | "queued"
    | "starting"
    | "running"
    | "completed"
    | "partial"
    | "blocked"
    | "failed"
    | "budget_skipped",
): BrowserObservationStatusResponse["status"] {
  if (status === "starting" || status === "running") return "running";
  if (status === "failed" || status === "budget_skipped") return "unavailable";
  return status;
}

export async function getBrowserObservationForScan(
  scanId: string,
  token: string,
): Promise<BrowserObservationStatusResponse | undefined> {
  if (getServerConfig().APIFY_BROWSER_MODE !== "report") return undefined;
  const scan = await authorizeScan(scanId, token);
  if (!scan) return undefined;
  const { db } = getDatabase();
  const observation =
    await createBrowserObservationRepository(db).getForScan(scanId);
  if (!observation) return undefined;
  const teaserFindings = observation.findings
    .filter(
      ({ status, remediation_code }) =>
        status === "fail" ||
        (status === "partial" && Boolean(remediation_code)),
    )
    .slice(0, 3)
    .map((finding) => ({ ...finding, evidence: {} }));
  return {
    version: BROWSER_OBSERVATION_VERSION,
    status: publicBrowserStatus(observation.status),
    non_scoring: true,
    pages_assessed: observation.pagesAssessed,
    findings: teaserFindings,
    updated_at: observation.updatedAt.toISOString(),
  };
}
