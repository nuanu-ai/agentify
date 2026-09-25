import {
  BROWSER_OBSERVATION_VERSION,
  type BrowserObservationStatusResponse,
  CHECK_DEFINITIONS,
  type PublicShareSnapshot,
  publicShareSnapshotSchema,
  type ReportResponse,
  type SharePreviewResponse,
} from "@agentify/scanner-contracts";
import {
  createBrowserObservationRepository,
  createUuidV7,
  emitStoredBusinessEvent,
  leadScans,
  leads,
  scanChecks,
  scanShares,
  scans,
  sessions,
  waitlistEntries,
} from "@agentify/scanner-database";
import { and, avg, count, eq, sql } from "drizzle-orm";

import { ownedLead, type Visitor, visitorOf } from "./auth";
import { getServerConfig } from "./config";
import { deriveCapability, hmacHex } from "./crypto";
import { getDatabase } from "./database";
import { requestScannerIdentityDeletion } from "./scanner-identity-deletion";

const PRIVATE_EVIDENCE_KEY =
  /(?:url|host|ip|header|endpoint|body|token|cookie|authorization|trace)/i;
const PRIVATE_EVIDENCE_VALUE =
  /(?:https?:\/\/|www\.|(?:^|\s)(?:\d{1,3}\.){3}\d{1,3}(?:\s|$)|(?:^|\s)\/?(?:\.well-known|api\/)|[\w.-]+\.[a-z]{2,}(?:\/|\s|$))/i;

function sanitizeEvidence(value: unknown): Record<string, string | number | boolean | string[]> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const output: Record<string, string | number | boolean | string[]> = {};
  for (const [key, item] of Object.entries(value)) {
    if (PRIVATE_EVIDENCE_KEY.test(key)) continue;
    if (typeof item === "string" && !PRIVATE_EVIDENCE_VALUE.test(item))
      output[key] = item.slice(0, 300);
    else if (typeof item === "number" || typeof item === "boolean") output[key] = item;
    else if (Array.isArray(item) && item.every((entry) => typeof entry === "string")) {
      output[key] = item
        .filter((entry) => !PRIVATE_EVIDENCE_VALUE.test(entry))
        .slice(0, 20)
        .map((entry) => entry.slice(0, 200));
    }
  }
  return output;
}

/**
 * What a report page draws, from one reading of who is visiting.
 *
 * The cabinet's silence, a stranger, a person the report is not filed under,
 * and the report itself are four different pages, and the reading that tells
 * them apart is made once here so that nothing later on the page can be told
 * a different story.
 */
export async function loadReportPage(
  scanId: string,
  cookieHeader: string | undefined | null,
): Promise<
  | Readonly<{ kind: "unknown" }>
  | Readonly<{ kind: "stranger" }>
  | Readonly<{ kind: "not_yours"; email: string }>
  | Readonly<{
      kind: "report";
      visitor: Visitor;
      report: ReportResponse;
      browserObservation: BrowserObservationStatusResponse | undefined;
    }>
> {
  const visitor = await visitorOf(cookieHeader);
  if (visitor.kind === "unknown") return { kind: "unknown" };
  if (visitor.kind === "stranger") return { kind: "stranger" };
  const report = await getFullReport(scanId, visitor);
  if (!report) return { kind: "not_yours", email: visitor.email };
  return {
    kind: "report",
    visitor,
    report,
    browserObservation: await getFullBrowserObservation(scanId, visitor),
  };
}

export async function getFullReport(
  scanId: string,
  visitor: Visitor,
): Promise<ReportResponse | undefined> {
  const leadId = await ownedLead(visitor, scanId);
  if (!leadId) return undefined;
  const verified = { leadId };
  const { db } = getDatabase();
  const scan = (await db.select().from(scans).where(eq(scans.id, scanId)).limit(1))[0];
  // The row in waitlist_entries is the record that this lead registered for
  // this scan; a report opens only for a registered lead.
  const registered = (
    await db
      .select({ id: waitlistEntries.id })
      .from(waitlistEntries)
      .where(and(eq(waitlistEntries.leadId, verified.leadId), eq(waitlistEntries.scanId, scanId)))
      .limit(1)
  )[0];
  if (!scan || !registered || scan.coverage === null || !scan.level) return undefined;
  const checkRows = await db.select().from(scanChecks).where(eq(scanChecks.scanId, scanId));
  const byId = new Map(checkRows.map((row) => [row.checkId, row]));
  const checks = CHECK_DEFINITIONS.map((definition) => {
    const row = byId.get(definition.id);
    return {
      id: definition.id,
      label_code: definition.labelCode,
      status: row?.status ?? ("unavailable" as const),
      summary_code: row?.summaryCode ?? null,
      user_impact_code: row?.userImpactCode ?? null,
      fix_code: row?.fixCode ?? null,
      evidence: sanitizeEvidence(row?.evidence),
    };
  });

  let benchmark: ReportResponse["benchmark"] = null;
  const config = getServerConfig();
  if (config.BENCHMARK_ENABLED) {
    const [aggregate] = await db
      .select({ sampleSize: count(), averageScore: avg(scans.score) })
      .from(scans)
      .where(
        and(
          eq(scans.segment, scan.segment),
          sql`${scans.status} in ('completed', 'partial')`,
          sql`${scans.coverage} >= 0.700`,
        ),
      );
    if (aggregate && aggregate.sampleSize >= 30 && aggregate.averageScore !== null) {
      benchmark = {
        sample_size: aggregate.sampleSize,
        average_score: Number(aggregate.averageScore),
      };
    }
  }
  return {
    scan_id: scan.id,
    host: scan.targetHost,
    segment: scan.segment,
    score: scan.score,
    coverage: Number(scan.coverage),
    level: scan.level,
    checks,
    benchmark,
  };
}

export async function getFullBrowserObservation(
  scanId: string,
  visitor: Visitor,
): Promise<BrowserObservationStatusResponse | undefined> {
  if (getServerConfig().APIFY_BROWSER_MODE !== "report") return undefined;
  if (!(await ownedLead(visitor, scanId))) return undefined;
  const { db } = getDatabase();
  const observation = await createBrowserObservationRepository(db).getForScan(scanId);
  if (!observation) return undefined;
  const status: BrowserObservationStatusResponse["status"] =
    observation.status === "starting" || observation.status === "running"
      ? "running"
      : observation.status === "failed" || observation.status === "budget_skipped"
        ? "unavailable"
        : observation.status;
  return {
    version: BROWSER_OBSERVATION_VERSION,
    status,
    non_scoring: true,
    pages_assessed: observation.pagesAssessed,
    findings: observation.findings.map((finding) => ({
      ...finding,
      evidence: sanitizeEvidence(finding.evidence),
    })),
    updated_at: observation.updatedAt.toISOString(),
  };
}

type ShareAuthorization = {
  verifiedLeadId?: string;
  scanTokenAuthorized: boolean;
};

export async function getPublicSharePreview(
  scanId: string,
): Promise<SharePreviewResponse | undefined> {
  const config = getServerConfig();
  if (!config.PUBLIC_SHARE_ENABLED) return undefined;
  const { db } = getDatabase();
  const scan = (await db.select().from(scans).where(eq(scans.id, scanId)).limit(1))[0];
  if (
    !scan ||
    scan.score === null ||
    !scan.level ||
    (scan.status !== "completed" && scan.status !== "partial")
  )
    return undefined;
  const existing = (
    await db
      .select({ id: scanShares.id })
      .from(scanShares)
      .where(and(eq(scanShares.scanId, scanId), eq(scanShares.status, "published")))
      .limit(1)
  )[0];
  const existingSlug = existing
    ? deriveCapability(config.hmacSecret, "share-slug", existing.id)
    : null;
  return {
    host: scan.targetHost,
    score: scan.score,
    level: scan.level,
    rubric_version: scan.rubricVersion,
    generated_at: (
      scan.finishedAt ??
      scan.workerHeartbeatAt ??
      scan.queuedAt ??
      scan.acceptedAt
    ).toISOString(),
    existing_share: existingSlug
      ? {
          slug: existingSlug,
          public_url: `${config.appBaseUrl}/s/${existingSlug}`,
          status: "published",
        }
      : null,
  };
}

export async function createPublicShare(
  scanId: string,
  authorization: ShareAuthorization,
  allowIndexingRequested: boolean,
) {
  if (!getServerConfig().PUBLIC_SHARE_ENABLED) return undefined;
  const { db } = getDatabase();
  const scan = (await db.select().from(scans).where(eq(scans.id, scanId)).limit(1))[0];
  if (
    !scan ||
    scan.score === null ||
    !scan.level ||
    (scan.status !== "completed" && scan.status !== "partial")
  )
    return undefined;
  const existing = (
    await db
      .select({ id: scanShares.id })
      .from(scanShares)
      .where(and(eq(scanShares.scanId, scanId), eq(scanShares.status, "published")))
      .limit(1)
  )[0];
  if (existing) {
    return {
      conflict: false as const,
      slug: deriveCapability(getServerConfig().hmacSecret, "share-slug", existing.id),
      snapshot: undefined,
    };
  }
  let allowIndexing = false;
  if (allowIndexingRequested && authorization.verifiedLeadId) {
    const ownership = (
      await db
        .select({ claim: leadScans.siteOwnershipClaim })
        .from(leadScans)
        .where(
          and(eq(leadScans.leadId, authorization.verifiedLeadId), eq(leadScans.scanId, scanId)),
        )
        .limit(1)
    )[0];
    allowIndexing = ownership?.claim === true;
  }
  const shareId = createUuidV7();
  const slug = deriveCapability(getServerConfig().hmacSecret, "share-slug", shareId);
  const snapshot: PublicShareSnapshot = {
    host: scan.targetHost,
    score: scan.score,
    level: scan.level,
    rubric_version: scan.rubricVersion,
    generated_at: (
      scan.finishedAt ??
      scan.workerHeartbeatAt ??
      scan.queuedAt ??
      scan.acceptedAt
    ).toISOString(),
  };
  await db.transaction(async (tx) => {
    await tx.insert(scanShares).values({
      id: shareId,
      scanId,
      shareSlugHash: hmacHex(getServerConfig().hmacSecret, "share", slug),
      publicSnapshot: snapshot,
      allowIndexing,
    });
    const session = (
      await tx.select().from(sessions).where(eq(sessions.id, scan.sessionId)).limit(1)
    )[0];
    if (session?.consentSnapshotId) {
      await emitStoredBusinessEvent(tx, {
        name: "result_shared",
        identifiers: { share_id: shareId },
        sessionId: scan.sessionId,
        consentSnapshotId: session.consentSnapshotId,
        leadId: authorization.verifiedLeadId,
        scanId,
        segment: scan.segment,
        landingVariant: session.firstLandingVariant ?? "unknown",
        properties: { share_method: "explicit_public_link" },
      });
    }
  });
  return { conflict: false as const, slug, snapshot };
}

export async function getPublicShare(slug: string) {
  const { db } = getDatabase();
  const row = (
    await db
      .select()
      .from(scanShares)
      .where(eq(scanShares.shareSlugHash, hmacHex(getServerConfig().hmacSecret, "share", slug)))
      .limit(1)
  )[0];
  if (row?.status !== "published") return undefined;
  const snapshot = publicShareSnapshotSchema.safeParse(row.publicSnapshot);
  return snapshot.success ? { ...row, snapshot: snapshot.data } : undefined;
}

export async function revokePublicShare(
  slug: string,
  authorization: ShareAuthorization,
): Promise<"revoked" | "not_found" | "unauthorized"> {
  const row = await getPublicShare(slug);
  if (!row) return "not_found";
  const verifiedAllowed = authorization.verifiedLeadId
    ? Boolean(
        (
          await getDatabase()
            .db.select({ leadId: leadScans.leadId })
            .from(leadScans)
            .where(
              and(
                eq(leadScans.leadId, authorization.verifiedLeadId),
                eq(leadScans.scanId, row.scanId),
              ),
            )
            .limit(1)
        )[0],
      )
    : false;
  if (!authorization.scanTokenAuthorized && !verifiedAllowed) return "unauthorized";
  await getDatabase()
    .db.update(scanShares)
    .set({ status: "revoked", revokedAt: new Date() })
    .where(eq(scanShares.id, row.id));
  return "revoked";
}

export async function updateAccountState(
  leadId: string,
  action: "unsubscribe" | "access" | "deletion",
): Promise<"requested" | "completed"> {
  const { db } = getDatabase();
  const now = new Date();
  if (action === "unsubscribe") {
    await db.update(leads).set({ unsubscribedAt: now }).where(eq(leads.id, leadId));
    return "requested";
  }
  if (action === "access") {
    await db.update(leads).set({ dataAccessRequestedAt: now }).where(eq(leads.id, leadId));
    return "requested";
  }
  return await requestScannerIdentityDeletion({ leadId });
}
