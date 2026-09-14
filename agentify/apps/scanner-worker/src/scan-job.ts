import { createHash } from "node:crypto";
import {
  BROWSER_OBSERVATION_VERSION,
  type BrowserObservationJobV1,
  type CheckResult,
  type ScanJobV1,
} from "@b2a/contracts";
import { createUuidV7 } from "@b2a/db";
import type { ScanEvaluation } from "@b2a/scanner-core";
import type { ScanRunner } from "./scan-runner.js";

export type ReusableScanSnapshot = ScanEvaluation & {
  sourceScanId: string;
  expiresAt: Date;
};

export type TerminalCommit = {
  scanId: string;
  attemptNo: number;
  evaluation: ScanEvaluation;
  cacheKey: string;
  cacheHit: boolean;
  sourceScanId?: string;
  finishedAt: Date;
  browserObservation?: {
    id: string;
    operationId: string;
    operationKey: string;
    observationVersion: typeof BROWSER_OBSERVATION_VERSION;
    actorId: string;
    actorBuild: string;
  };
};

export interface ScanJobRepository {
  /** Atomic queued/running-stale -> running CAS. Terminal scans return terminal. */
  claim(job: ScanJobV1): Promise<"claimed" | "terminal" | "in_progress">;
  heartbeat(scanId: string, attemptNo: number, at: Date): Promise<void>;
  upsertCheck(
    scanId: string,
    attemptNo: number,
    check: CheckResult,
    at: Date,
  ): Promise<boolean>;
  findReusableSnapshot(
    cacheKey: string,
    now: Date,
  ): Promise<ReusableScanSnapshot | undefined>;
  /** One transaction: score/fingerprint/snapshot/terminal status/scan_completed unique business event. */
  commitTerminal(
    input: TerminalCommit,
  ): Promise<"committed" | "already_terminal">;
  markSystemFailure(
    scanId: string,
    attemptNo: number,
    failureCode: string,
    retryable: boolean,
    at: Date,
  ): Promise<void>;
}

export type ScanJobMetric = (
  | { name: "scan_job_started"; value: 1 }
  | { name: "scan_job_terminal"; value: 1; status: string }
  | { name: "scan_job_cache_hit"; value: 1 }
  | { name: "scan_job_skipped_terminal"; value: 1 }
  | { name: "scan_job_claim_conflict"; value: 1 }
  | { name: "scan_job_failure"; value: 1; code: string }
  | { name: "browser_observation_enqueue_failed"; value: 1 }
) & { scanId: string; attemptNo: number };

export type ProcessScanJobDependencies = {
  repository: ScanJobRepository;
  runner: ScanRunner;
  cacheEnabled: boolean;
  browserObservation?: {
    actorId: string;
    actorBuild: string;
    sampleRate: number;
    enqueue: (job: BrowserObservationJobV1) => Promise<void>;
  };
  emitMetric?: (metric: ScanJobMetric) => void;
  now?: () => Date;
};

const cacheKeyFor = (job: ScanJobV1): string =>
  createHash("sha256")
    .update(
      `${job.rubric_version}\0${job.segment}\0${job.canonical_target_url}`,
    )
    .digest("hex");

const sampledForBrowserObservation = (
  scanId: string,
  sampleRate: number,
): boolean => {
  if (sampleRate >= 1) return true;
  if (sampleRate <= 0) return false;
  const sample = createHash("sha256").update(scanId).digest().readUInt32BE(0);
  return sample / 0x1_0000_0000 < sampleRate;
};

const browserObservationAllowedByRobots = (
  checks: readonly CheckResult[],
): boolean =>
  !checks.some(
    (check) =>
      check.errorCode === "robots_disallowed" ||
      check.errorCode === "robots_unavailable",
  );

const operationalCode = (error: unknown): string => {
  if (!(error instanceof Error)) return "unknown_system_error";
  const known = new Set([
    "scan_deadline_expired",
    "request_budget_exhausted",
    "global_deadline",
    "dns_no_answers",
    "redirect_limit_exceeded",
  ]);
  if (known.has(error.message)) return error.message;
  if (error.message.startsWith("ssrf_blocked:"))
    return error.message.slice(0, 64);
  return "scan_system_error";
};

export const processScanJob = async (
  job: ScanJobV1,
  dependencies: ProcessScanJobDependencies,
): Promise<"committed" | "skipped"> => {
  const claim = await dependencies.repository.claim(job);
  if (claim === "terminal") {
    dependencies.emitMetric?.({
      name: "scan_job_skipped_terminal",
      value: 1,
      scanId: job.scan_id,
      attemptNo: job.attempt_no,
    });
    return "skipped";
  }
  if (claim === "in_progress") {
    dependencies.emitMetric?.({
      name: "scan_job_claim_conflict",
      value: 1,
      scanId: job.scan_id,
      attemptNo: job.attempt_no,
    });
    return "skipped";
  }
  dependencies.emitMetric?.({
    name: "scan_job_started",
    value: 1,
    scanId: job.scan_id,
    attemptNo: job.attempt_no,
  });

  const now = dependencies.now ?? (() => new Date());
  const heartbeat = setInterval(() => {
    void dependencies.repository
      .heartbeat(job.scan_id, job.attempt_no, now())
      .catch(() => {
        // Heartbeat failure is observable by repository metrics; final CAS still protects state.
      });
  }, 10_000);
  heartbeat.unref();
  const cacheKey = cacheKeyFor(job);

  try {
    const snapshot = dependencies.cacheEnabled
      ? await dependencies.repository.findReusableSnapshot(cacheKey, now())
      : undefined;
    const progressivelyWritten = new Set<number>();
    const evaluation =
      snapshot ??
      (await dependencies.runner.run(job, {
        onChecksComplete: async (checks) => {
          for (const check of checks) {
            const written = await dependencies.repository.upsertCheck(
              job.scan_id,
              job.attempt_no,
              check,
              now(),
            );
            if (!written) throw new Error("scan_attempt_fenced");
            progressivelyWritten.add(check.id);
          }
        },
      }));
    for (const check of evaluation.checks) {
      if (progressivelyWritten.has(check.id)) continue;
      const written = await dependencies.repository.upsertCheck(
        job.scan_id,
        job.attempt_no,
        check,
        now(),
      );
      if (!written) return "skipped";
    }
    const browserObservation =
      dependencies.browserObservation &&
      evaluation.score.terminalStatus !== "failed" &&
      browserObservationAllowedByRobots(evaluation.checks) &&
      sampledForBrowserObservation(
        job.scan_id,
        dependencies.browserObservation.sampleRate,
      )
        ? (() => {
            const id = createUuidV7();
            const operationId = createUuidV7();
            return {
              id,
              operationId,
              operationKey: createHash("sha256")
                .update(`${job.scan_id}\0${BROWSER_OBSERVATION_VERSION}`)
                .digest("hex"),
              observationVersion: BROWSER_OBSERVATION_VERSION,
              actorId: dependencies.browserObservation.actorId,
              actorBuild: dependencies.browserObservation.actorBuild,
            };
          })()
        : undefined;
    const committed = await dependencies.repository.commitTerminal({
      scanId: job.scan_id,
      attemptNo: job.attempt_no,
      evaluation,
      cacheKey,
      cacheHit: Boolean(snapshot),
      ...(snapshot ? { sourceScanId: snapshot.sourceScanId } : {}),
      finishedAt: now(),
      ...(browserObservation ? { browserObservation } : {}),
    });
    if (committed === "committed" && browserObservation) {
      try {
        await dependencies.browserObservation?.enqueue({
          observation_id: browserObservation.id,
          operation_id: browserObservation.operationId,
          attempt_no: 1,
        });
      } catch {
        dependencies.emitMetric?.({
          name: "browser_observation_enqueue_failed",
          value: 1,
          scanId: job.scan_id,
          attemptNo: job.attempt_no,
        });
        // Reconciler will publish the transactionally-created queued row.
      }
    }
    if (snapshot)
      dependencies.emitMetric?.({
        name: "scan_job_cache_hit",
        value: 1,
        scanId: job.scan_id,
        attemptNo: job.attempt_no,
      });
    dependencies.emitMetric?.({
      name: "scan_job_terminal",
      value: 1,
      status: evaluation.score.terminalStatus,
      scanId: job.scan_id,
      attemptNo: job.attempt_no,
    });
    return committed === "committed" ? "committed" : "skipped";
  } catch (error) {
    if (error instanceof Error && error.message === "scan_attempt_fenced")
      return "skipped";
    const code = operationalCode(error);
    dependencies.emitMetric?.({
      name: "scan_job_failure",
      value: 1,
      code,
      scanId: job.scan_id,
      attemptNo: job.attempt_no,
    });
    await dependencies.repository.markSystemFailure(
      job.scan_id,
      job.attempt_no,
      code,
      job.attempt_no < 2,
      now(),
    );
    throw error;
  } finally {
    clearInterval(heartbeat);
  }
};

export type BossJob<T> = { data: T; retryCount: number };
export interface ScanBoss {
  work<T>(
    name: string,
    options: {
      localConcurrency: number;
      batchSize: 1;
      includeMetadata: true;
    },
    handler: (jobs: BossJob<T>[]) => Promise<void>,
  ): Promise<string>;
}

/** pg-boss acknowledges only after processScanJob resolves after terminal commit. */
export const registerScanWorker = async (
  boss: ScanBoss,
  dependencies: ProcessScanJobDependencies,
  concurrency = 10,
): Promise<string> =>
  await boss.work<ScanJobV1>(
    "scan-v1",
    {
      localConcurrency: concurrency,
      batchSize: 1,
      includeMetadata: true,
    },
    async (jobs) => {
      for (const job of jobs) {
        const effectiveAttempt = Math.min(
          2,
          job.data.attempt_no + job.retryCount,
        );
        await processScanJob(
          { ...job.data, attempt_no: effectiveAttempt },
          dependencies,
        );
      }
    },
  );
