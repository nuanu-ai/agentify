import type {
  CheckResult,
  DiagnosticLevel,
  ScanJobV1,
} from "@agentify/scanner-contracts";
import { and, eq, sql } from "drizzle-orm";
import { emitStoredBusinessEvent } from "./analytics-runtime.js";
import type { Database } from "./client.js";
import {
  browserObservations,
  scanChecks,
  scanFingerprints,
  scanSnapshots,
  scans,
  sessions,
} from "./schema.js";

type ScanEvaluationData = {
  checks: CheckResult[];
  score: {
    rubricVersion: "gtm-v1.0.0";
    score: number | null;
    coverage: number;
    level: DiagnosticLevel;
    terminalStatus: "completed" | "partial" | "failed";
    nominalWeight: number;
    applicableWeight: number;
    assessedWeight: number;
    earnedWeight: number;
  };
  fingerprint: {
    detectorVersion: string;
    platform: {
      value: string;
      confidence: "high" | "medium" | "low";
      signals: string[];
    };
    wafCdn: Array<{
      value: string;
      confidence: "high" | "medium" | "low";
      signals: string[];
    }>;
    pspMarkers: Array<{
      value: string;
      confidence: "high" | "medium" | "low";
      signals: string[];
    }>;
  };
  findings: { negativeCheckIds: number[]; positiveCheckId?: number };
};

type TerminalCommitData = {
  scanId: string;
  attemptNo: number;
  evaluation: ScanEvaluationData;
  cacheKey: string;
  cacheHit: boolean;
  sourceScanId?: string;
  finishedAt: Date;
  browserObservation?: {
    id: string;
    operationId: string;
    operationKey: string;
    observationVersion: string;
    actorId: string;
    actorBuild: string;
  };
};

type SnapshotData = ScanEvaluationData & {
  sourceScanId: string;
  expiresAt: Date;
};

export function createScanJobRepository(db: Database) {
  return {
    async claim(
      job: ScanJobV1,
    ): Promise<"claimed" | "terminal" | "in_progress"> {
      return await db.transaction(async (tx) => {
        const result = await tx.execute<{ status: string; attempt_no: number }>(
          sql`select status, attempt_no from scans where id = ${job.scan_id} for update`,
        );
        const current = result.rows[0];
        if (!current) throw new Error("scan_not_found");
        if (["completed", "partial", "failed"].includes(current.status))
          return "terminal";
        if (current.attempt_no > job.attempt_no) return "in_progress";
        if (
          current.status === "running" &&
          current.attempt_no >= job.attempt_no
        )
          return "in_progress";
        if (job.attempt_no > current.attempt_no) {
          await tx.delete(scanChecks).where(eq(scanChecks.scanId, job.scan_id));
        }
        await tx
          .update(scans)
          .set({
            status: "running",
            attemptNo: job.attempt_no,
            startedAt: new Date(),
            workerHeartbeatAt: new Date(),
          })
          .where(eq(scans.id, job.scan_id));
        return "claimed";
      });
    },

    async heartbeat(
      scanId: string,
      attemptNo: number,
      at: Date,
    ): Promise<void> {
      await db
        .update(scans)
        .set({ workerHeartbeatAt: at })
        .where(
          and(
            eq(scans.id, scanId),
            eq(scans.status, "running"),
            eq(scans.attemptNo, attemptNo),
          ),
        );
    },

    async upsertCheck(
      scanId: string,
      attemptNo: number,
      checkResult: CheckResult,
      at: Date,
    ): Promise<boolean> {
      const values = {
        scanId,
        checkId: checkResult.id,
        status: checkResult.status,
        nominalWeight: String(checkResult.nominalWeight),
        applicableWeight: String(checkResult.applicableWeight),
        earnedWeight: String(checkResult.earnedWeight),
        finishedAt: at,
        summaryCode: checkResult.summaryCode,
        userImpactCode: checkResult.userImpactCode,
        fixCode: checkResult.fixCode ?? null,
        durationMs: checkResult.durationMs,
        evidence: checkResult.evidence,
        errorCode: checkResult.errorCode ?? null,
      };
      return await db.transaction(async (tx) => {
        const fence = await tx.execute<{ id: string }>(
          sql`select id from scans
              where id = ${scanId} and status = 'running' and attempt_no = ${attemptNo}
              for update`,
        );
        if (!fence.rows[0]) return false;
        await tx
          .insert(scanChecks)
          .values(values)
          .onConflictDoUpdate({
            target: [scanChecks.scanId, scanChecks.checkId],
            set: values,
          });
        return true;
      });
    },

    async findReusableSnapshot(
      cacheKey: string,
      now: Date,
    ): Promise<SnapshotData | undefined> {
      const [snapshot] = await db
        .select()
        .from(scanSnapshots)
        .where(
          and(
            eq(scanSnapshots.cacheKey, cacheKey),
            sql`${scanSnapshots.expiresAt} > ${now}`,
            sql`${scanSnapshots.invalidatedAt} is null`,
            sql`${scanSnapshots.coverage} >= 0.700`,
          ),
        )
        .limit(1);
      if (!snapshot) return undefined;
      const stored = snapshot.checks as ScanEvaluationData;
      return {
        ...stored,
        fingerprint: snapshot.fingerprint as ScanEvaluationData["fingerprint"],
        sourceScanId: snapshot.id,
        expiresAt: snapshot.expiresAt,
      };
    },

    async commitTerminal(
      input: TerminalCommitData,
    ): Promise<"committed" | "already_terminal"> {
      return await db.transaction(async (tx) => {
        const locked = await tx.execute<{
          status: string;
          attempt_no: number;
          session_id: string;
          segment: "store" | "owner" | "local";
          canonical_target_url: string;
        }>(
          sql`select status, attempt_no, session_id, segment, canonical_target_url from scans where id = ${input.scanId} for update`,
        );
        const current = locked.rows[0];
        if (!current) throw new Error("scan_not_found");
        if (["completed", "partial", "failed"].includes(current.status))
          return "already_terminal";
        if (
          current.status !== "running" ||
          current.attempt_no !== input.attemptNo
        )
          return "already_terminal";

        const score = input.evaluation.score;
        const updated = await tx
          .update(scans)
          .set({
            status: score.terminalStatus,
            score: score.score,
            coverage: String(score.coverage),
            level: score.level,
            applicableWeight: String(score.applicableWeight),
            earnedWeight: String(score.earnedWeight),
            cacheHit: input.cacheHit,
            sourceScanId: input.sourceScanId ?? null,
            finishedAt: input.finishedAt,
            workerHeartbeatAt: input.finishedAt,
          })
          .where(
            and(
              eq(scans.id, input.scanId),
              eq(scans.attemptNo, input.attemptNo),
              eq(scans.status, "running"),
            ),
          )
          .returning({ id: scans.id });
        if (!updated[0]) return "already_terminal";

        const fingerprint = input.evaluation.fingerprint;
        await tx
          .insert(scanFingerprints)
          .values({
            scanId: input.scanId,
            platform: fingerprint.platform.value,
            platformConfidence: fingerprint.platform.confidence,
            wafCdn: fingerprint.wafCdn.map(({ value }) => value),
            pspMarkers: fingerprint.pspMarkers.map(({ value }) => value),
            feedSignals: [],
            headerSignals: {},
            htmlSignals: {},
            detectorVersion: fingerprint.detectorVersion,
          })
          .onConflictDoUpdate({
            target: scanFingerprints.scanId,
            set: {
              platform: fingerprint.platform.value,
              platformConfidence: fingerprint.platform.confidence,
              wafCdn: fingerprint.wafCdn.map(({ value }) => value),
              pspMarkers: fingerprint.pspMarkers.map(({ value }) => value),
              detectorVersion: fingerprint.detectorVersion,
            },
          });

        if (
          !input.cacheHit &&
          score.terminalStatus !== "failed" &&
          score.coverage >= 0.7 &&
          score.score !== null
        ) {
          await tx
            .insert(scanSnapshots)
            .values({
              id: input.scanId,
              cacheKey: input.cacheKey,
              rubricVersion: score.rubricVersion,
              segmentProfile: current.segment,
              canonicalTargetUrl: current.canonical_target_url,
              checks: input.evaluation,
              fingerprint,
              score: score.score,
              coverage: String(score.coverage),
              expiresAt: new Date(input.finishedAt.getTime() + 86_400_000),
            })
            .onConflictDoNothing({ target: scanSnapshots.cacheKey });
        }

        if (
          input.browserObservation &&
          ["completed", "partial"].includes(score.terminalStatus)
        ) {
          await tx
            .insert(browserObservations)
            .values({
              id: input.browserObservation.id,
              scanId: input.scanId,
              observationVersion: input.browserObservation.observationVersion,
              operationId: input.browserObservation.operationId,
              operationKey: input.browserObservation.operationKey,
              actorId: input.browserObservation.actorId,
              actorBuild: input.browserObservation.actorBuild,
              status: "queued",
              queuedAt: input.finishedAt,
              updatedAt: input.finishedAt,
            })
            .onConflictDoNothing({
              target: [
                browserObservations.scanId,
                browserObservations.observationVersion,
              ],
            });
        }

        if (score.terminalStatus !== "failed") {
          const [session] = await tx
            .select({
              consentSnapshotId: sessions.consentSnapshotId,
              landingVariant: sessions.firstLandingVariant,
            })
            .from(sessions)
            .where(eq(sessions.id, current.session_id))
            .limit(1);
          if (!session?.consentSnapshotId)
            throw new Error("scan_session_missing_consent_snapshot");
          await emitStoredBusinessEvent(tx, {
            name: "scan_completed",
            identifiers: { scan_id: input.scanId },
            sessionId: current.session_id,
            consentSnapshotId: session.consentSnapshotId,
            scanId: input.scanId,
            segment: current.segment,
            landingVariant: session.landingVariant ?? "unknown",
            properties: {
              cache_hit: input.cacheHit,
              coverage: score.coverage,
              terminal_status: score.terminalStatus,
            },
            occurredAt: input.finishedAt,
          });
        }
        return "committed";
      });
    },

    async markSystemFailure(
      scanId: string,
      attemptNo: number,
      failureCode: string,
      retryable: boolean,
      at: Date,
    ): Promise<void> {
      await db
        .update(scans)
        .set(
          retryable
            ? { status: "queued", failureCode, workerHeartbeatAt: at }
            : {
                status: "failed",
                failureCode,
                finishedAt: at,
                level: "incomplete",
                workerHeartbeatAt: at,
              },
        )
        .where(
          and(
            eq(scans.id, scanId),
            eq(scans.attemptNo, attemptNo),
            eq(scans.status, "running"),
          ),
        );
    },
  };
}
