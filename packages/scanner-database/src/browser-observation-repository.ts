import {
  BROWSER_OBSERVATION_VERSION,
  browserObservationFindingSchema,
  browserObservationOutputV1Schema,
  browserObservationSignalsSchema,
  type BrowserObservationJobV1,
  type BrowserObservationLifecycleStatus,
  type BrowserObservationOutputV1,
} from "@agentify/scanner-contracts";
import { and, asc, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";

import type { Database } from "./client.js";
import { createUuidV7 } from "./ids.js";
import {
  browserObservationBudgetDays,
  browserObservationFindings,
  browserObservations,
} from "./schema.js";

const ACTIVE_STATUSES = ["starting", "running"] as const;
const TERMINAL_STATUSES = [
  "completed",
  "partial",
  "blocked",
  "failed",
  "budget_skipped",
] as const;

export type BrowserObservationClaim = {
  id: string;
  scanId: string;
  operationId: string;
  canonicalTargetUrl: string;
  registrableDomain: string;
  segment: "store" | "owner" | "local";
  actorId: string;
  actorBuild: string;
  apifyRunId: string | null;
  leaseToken: string;
  startedAt: Date;
  resuming: boolean;
};

export type BrowserObservationCleanupCandidate = {
  observationId: string;
  operationId: string;
  actorId: string;
  apifyRunId: string | null;
};

export type BrowserObservationUsageCandidate =
  BrowserObservationCleanupCandidate;

export type BrowserObservationUsageReconciliation = {
  state: "updated" | "unchanged" | "missing";
  deltaUsd: number;
  dayTotalUsd: number;
};

export type BrowserObservationRecord = {
  id: string;
  version: typeof BROWSER_OBSERVATION_VERSION;
  actorBuild: string;
  status: BrowserObservationLifecycleStatus;
  pagesAssessed: number;
  signals: BrowserObservationOutputV1["signals"] | null;
  findings: BrowserObservationOutputV1["observations"];
  updatedAt: Date;
};

const utcBudgetDay = (at: Date): string => at.toISOString().slice(0, 10);

const actualUsageUsd = (
  value: number | undefined,
  reservedUsd: number,
): number =>
  value !== undefined && Number.isFinite(value) && value >= 0
    ? Math.min(value, 9_999)
    : reservedUsd;

export function createBrowserObservationRepository(db: Database) {
  return {
    async claim(
      job: BrowserObservationJobV1,
      now = new Date(),
      leaseMs = 90_000,
    ): Promise<
      | { state: "claimed"; observation: BrowserObservationClaim }
      | { state: "terminal" | "in_progress" | "missing" }
    > {
      return await db.transaction(async (tx) => {
        const result = await tx.execute<{
          id: string;
          scan_id: string;
          operation_id: string;
          status: BrowserObservationLifecycleStatus;
          lease_expires_at: Date | null;
          actor_id: string;
          actor_build: string;
          apify_run_id: string | null;
          lease_token: string | null;
          started_at: Date | null;
          canonical_target_url: string;
          target_host: string;
          segment: "store" | "owner" | "local";
        }>(sql`
          select bo.id, bo.scan_id, bo.operation_id, bo.status,
            bo.lease_expires_at, bo.actor_id, bo.actor_build, bo.apify_run_id,
            bo.lease_token, bo.started_at,
            s.canonical_target_url, s.target_host, s.segment
          from browser_observations bo
          join scans s on s.id = bo.scan_id
          where bo.id = ${job.observation_id}
            and bo.operation_id = ${job.operation_id}
            and bo.attempt_no = ${job.attempt_no}
          for update of bo
        `);
        const current = result.rows[0];
        if (!current) return { state: "missing" } as const;
        if (TERMINAL_STATUSES.includes(current.status as never))
          return { state: "terminal" } as const;
        if (
          ACTIVE_STATUSES.includes(current.status as never) &&
          current.lease_expires_at &&
          current.lease_expires_at > now
        )
          return { state: "in_progress" } as const;

        const leaseExpiresAt = new Date(now.getTime() + leaseMs);
        const leaseToken = createUuidV7();
        await tx
          .update(browserObservations)
          .set({
            status: "starting",
            startedAt: current.status === "queued" ? now : undefined,
            leaseToken,
            leaseExpiresAt,
            updatedAt: now,
          })
          .where(eq(browserObservations.id, current.id));
        return {
          state: "claimed",
          observation: {
            id: current.id,
            scanId: current.scan_id,
            operationId: current.operation_id,
            canonicalTargetUrl: current.canonical_target_url,
            registrableDomain: current.target_host,
            segment: current.segment,
            actorId: current.actor_id,
            actorBuild: current.actor_build,
            apifyRunId: current.apify_run_id,
            leaseToken,
            startedAt: current.started_at ?? now,
            resuming: current.status !== "queued",
          },
        } as const;
      });
    },

    async attachRun(
      observationId: string,
      leaseToken: string,
      runId: string,
      at = new Date(),
      leaseMs = 90_000,
    ): Promise<"attached" | "owned_elsewhere" | "fenced"> {
      const rows = await db
        .update(browserObservations)
        .set({
          status: "running",
          apifyRunId: runId,
          lastPolledAt: at,
          leaseExpiresAt: new Date(at.getTime() + leaseMs),
          updatedAt: at,
        })
        .where(
          and(
            eq(browserObservations.id, observationId),
            eq(browserObservations.status, "starting"),
            eq(browserObservations.leaseToken, leaseToken),
          ),
        )
        .returning({ id: browserObservations.id });
      if (rows.length === 1) return "attached";
      const [current] = await db
        .select({
          apifyRunId: browserObservations.apifyRunId,
          status: browserObservations.status,
        })
        .from(browserObservations)
        .where(eq(browserObservations.id, observationId))
        .limit(1);
      return current &&
        (current.apifyRunId === runId ||
          ACTIVE_STATUSES.includes(current.status as never))
        ? "owned_elsewhere"
        : "fenced";
    },

    async heartbeat(
      observationId: string,
      leaseToken: string,
      at = new Date(),
      leaseMs = 90_000,
    ): Promise<boolean> {
      const rows = await db
        .update(browserObservations)
        .set({
          lastPolledAt: at,
          leaseExpiresAt: new Date(at.getTime() + leaseMs),
          updatedAt: at,
        })
        .where(
          and(
            eq(browserObservations.id, observationId),
            eq(browserObservations.leaseToken, leaseToken),
            inArray(browserObservations.status, ["starting", "running"]),
          ),
        )
        .returning({ id: browserObservations.id });
      return rows.length === 1;
    },

    async reserveDailyBudget(
      observationId: string,
      leaseToken: string,
      maxRunUsd: number,
      dailyBudgetUsd: number,
      at = new Date(),
    ): Promise<"reserved" | "exhausted" | "fenced"> {
      const budgetDay = utcBudgetDay(at);
      return await db.transaction(async (tx) => {
        const locked = await tx.execute<{
          budget_day: string | null;
          budget_reserved_usd: string;
        }>(sql`
          select budget_day::text, budget_reserved_usd::text
          from browser_observations
          where id = ${observationId}
            and lease_token = ${leaseToken}
            and status in ('starting', 'running')
          for update
        `);
        const current = locked.rows[0];
        if (!current) return "fenced" as const;
        if (Number(current.budget_reserved_usd) > 0) return "reserved" as const;

        await tx
          .insert(browserObservationBudgetDays)
          .values({ budgetDay, reservedUsd: "0", usageUsd: "0", updatedAt: at })
          .onConflictDoNothing({
            target: browserObservationBudgetDays.budgetDay,
          });
        const day = await tx.execute<{
          reserved_usd: string;
          usage_usd: string;
        }>(sql`
          select reserved_usd::text, usage_usd::text
          from browser_observation_budget_days
          where budget_day = ${budgetDay}::date
          for update
        `);
        const totals = day.rows[0];
        if (!totals) throw new Error("browser_budget_day_missing");
        if (
          Number(totals.reserved_usd) + Number(totals.usage_usd) + maxRunUsd >
          dailyBudgetUsd
        )
          return "exhausted" as const;

        await tx
          .update(browserObservationBudgetDays)
          .set({
            reservedUsd: sql`${browserObservationBudgetDays.reservedUsd} + ${maxRunUsd}`,
            updatedAt: at,
          })
          .where(eq(browserObservationBudgetDays.budgetDay, budgetDay));
        await tx
          .update(browserObservations)
          .set({
            budgetDay,
            budgetReservedUsd: String(maxRunUsd),
            updatedAt: at,
          })
          .where(
            and(
              eq(browserObservations.id, observationId),
              eq(browserObservations.leaseToken, leaseToken),
            ),
          );
        return "reserved" as const;
      });
    },

    async complete(
      observationId: string,
      leaseToken: string,
      untrustedOutput: unknown,
      input: { usageUsd?: number; finishedAt?: Date } = {},
    ): Promise<"committed" | "fenced"> {
      const output = browserObservationOutputV1Schema.parse(untrustedOutput);
      const finishedAt = input.finishedAt ?? new Date();
      return await db.transaction(async (tx) => {
        const locked = await tx.execute<{
          operation_id: string;
          status: BrowserObservationLifecycleStatus;
          budget_day: string | null;
          budget_reserved_usd: string;
        }>(sql`
          select operation_id, status, budget_day::text,
            budget_reserved_usd::text
          from browser_observations
          where id = ${observationId}
            and lease_token = ${leaseToken}
          for update
        `);
        const current = locked.rows[0];
        if (
          !current ||
          current.operation_id !== output.operation_id ||
          !ACTIVE_STATUSES.includes(current.status as never)
        )
          return "fenced";

        const reservedUsd = Number(current.budget_reserved_usd);
        const usageUsd = actualUsageUsd(input.usageUsd, reservedUsd);
        const settledReservationUsd = Math.min(reservedUsd, usageUsd);
        const remainingReservationUsd = Math.max(
          0,
          reservedUsd - settledReservationUsd,
        );
        if (current.budget_day && reservedUsd > 0) {
          await tx.execute(sql`
            update browser_observation_budget_days
            set reserved_usd = greatest(0, reserved_usd - ${settledReservationUsd}),
                usage_usd = usage_usd + ${usageUsd},
                updated_at = ${finishedAt}
            where budget_day = ${current.budget_day}::date
          `);
        }

        await tx
          .delete(browserObservationFindings)
          .where(eq(browserObservationFindings.observationId, observationId));
        if (output.observations.length) {
          await tx.insert(browserObservationFindings).values(
            output.observations.map((finding) => ({
              observationId,
              findingId: finding.id,
              status: finding.status,
              summaryCode: finding.summary_code,
              userImpactCode: finding.user_impact_code ?? null,
              remediationCode: finding.remediation_code ?? null,
              evidence: finding.evidence,
            })),
          );
        }
        const terminalRows = await tx
          .update(browserObservations)
          .set({
            status: output.status,
            actorBuild: output.actor_build,
            pagesAssessed: output.pages_assessed,
            requestCount: output.signals.request_count,
            transferredBytes: output.signals.transferred_bytes,
            durationMs: output.timings.total_ms,
            usageUsd: String(usageUsd),
            budgetReservedUsd: String(remainingReservationUsd),
            usageReconciledAt: remainingReservationUsd > 0 ? null : finishedAt,
            signals: output.signals,
            failureCode: output.status === "failed" ? "actor_failed" : null,
            finishedAt,
            lastPolledAt: finishedAt,
            leaseToken: null,
            leaseExpiresAt: null,
            updatedAt: finishedAt,
          })
          .where(
            and(
              eq(browserObservations.id, observationId),
              eq(browserObservations.leaseToken, leaseToken),
              inArray(browserObservations.status, ["starting", "running"]),
            ),
          )
          .returning({ id: browserObservations.id });
        if (terminalRows.length !== 1)
          throw new Error("browser_observation_fence_lost");
        return "committed";
      });
    },

    async markTerminal(
      observationId: string,
      leaseToken: string,
      status: "blocked" | "failed" | "budget_skipped",
      failureCode: string,
      input: { at?: Date; usageUsd?: number } = {},
    ): Promise<boolean> {
      const at = input.at ?? new Date();
      return await db.transaction(async (tx) => {
        const locked = await tx.execute<{
          budget_day: string | null;
          budget_reserved_usd: string;
        }>(sql`
          select budget_day::text, budget_reserved_usd::text
          from browser_observations
          where id = ${observationId}
            and lease_token = ${leaseToken}
            and status in ('queued', 'starting', 'running')
          for update
        `);
        const current = locked.rows[0];
        if (!current) return false;
        const reservedUsd = Number(current.budget_reserved_usd);
        const usageUsd = actualUsageUsd(input.usageUsd, reservedUsd);
        const settledReservationUsd = Math.min(reservedUsd, usageUsd);
        const remainingReservationUsd = Math.max(
          0,
          reservedUsd - settledReservationUsd,
        );
        if (current.budget_day && reservedUsd > 0) {
          await tx.execute(sql`
            update browser_observation_budget_days
            set reserved_usd = greatest(0, reserved_usd - ${settledReservationUsd}),
                usage_usd = usage_usd + ${usageUsd},
                updated_at = ${at}
            where budget_day = ${current.budget_day}::date
          `);
        }
        const rows = await tx
          .update(browserObservations)
          .set({
            status,
            failureCode: failureCode.slice(0, 200),
            usageUsd: String(usageUsd),
            budgetReservedUsd: String(remainingReservationUsd),
            usageReconciledAt: remainingReservationUsd > 0 ? null : at,
            finishedAt: at,
            leaseToken: null,
            leaseExpiresAt: null,
            updatedAt: at,
          })
          .where(
            and(
              eq(browserObservations.id, observationId),
              eq(browserObservations.leaseToken, leaseToken),
            ),
          )
          .returning({ id: browserObservations.id });
        return rows.length === 1;
      });
    },

    async reconcileUsage(
      observationId: string,
      runId: string,
      providerUsageUsd: number,
      at = new Date(),
    ): Promise<BrowserObservationUsageReconciliation> {
      const safeProviderUsageUsd = actualUsageUsd(providerUsageUsd, 0);
      return await db.transaction(async (tx) => {
        const locked = await tx.execute<{
          status: BrowserObservationLifecycleStatus;
          budget_day: string | null;
          budget_reserved_usd: string;
          usage_usd: string | null;
        }>(sql`
          select status, budget_day::text, budget_reserved_usd::text,
            usage_usd::text
          from browser_observations
          where id = ${observationId}
            and apify_run_id = ${runId}
          for update
        `);
        const current = locked.rows[0];
        if (!current || !TERMINAL_STATUSES.includes(current.status as never))
          return { state: "missing", deltaUsd: 0, dayTotalUsd: 0 };

        const currentUsageUsd = Number(current.usage_usd ?? 0);
        const reconciledUsageUsd = Math.max(
          currentUsageUsd,
          safeProviderUsageUsd,
        );
        const deltaUsd = Math.max(0, reconciledUsageUsd - currentUsageUsd);
        const remainingReservationUsd = Number(current.budget_reserved_usd);
        let dayTotalUsd = reconciledUsageUsd;
        if (current.budget_day) {
          const totals = await tx.execute<{
            breaker_usage_usd: string;
          }>(sql`
            update browser_observation_budget_days
            set reserved_usd = greatest(0, reserved_usd - ${remainingReservationUsd}),
                usage_usd = usage_usd + ${deltaUsd},
                updated_at = ${at}
            where budget_day = ${current.budget_day}::date
            returning (usage_usd + reserved_usd)::text as breaker_usage_usd
          `);
          dayTotalUsd = Number(
            totals.rows[0]?.breaker_usage_usd ?? reconciledUsageUsd,
          );
        }

        await tx
          .update(browserObservations)
          .set({
            usageUsd: String(reconciledUsageUsd),
            budgetReservedUsd: "0",
            usageReconciledAt: at,
            updatedAt: at,
          })
          .where(eq(browserObservations.id, observationId));
        return {
          state:
            deltaUsd > 0 || remainingReservationUsd > 0
              ? "updated"
              : "unchanged",
          deltaUsd,
          dayTotalUsd,
        };
      });
    },

    async settleUsageConservatively(
      observationId: string,
      at = new Date(),
    ): Promise<BrowserObservationUsageReconciliation> {
      return await db.transaction(async (tx) => {
        const locked = await tx.execute<{
          status: BrowserObservationLifecycleStatus;
          budget_day: string | null;
          budget_reserved_usd: string;
          usage_usd: string | null;
        }>(sql`
          select status, budget_day::text, budget_reserved_usd::text,
            usage_usd::text
          from browser_observations
          where id = ${observationId}
          for update
        `);
        const current = locked.rows[0];
        if (!current || !TERMINAL_STATUSES.includes(current.status as never))
          return { state: "missing", deltaUsd: 0, dayTotalUsd: 0 };

        const currentUsageUsd = Number(current.usage_usd ?? 0);
        const remainingReservationUsd = Number(current.budget_reserved_usd);
        const conservativeUsageUsd = currentUsageUsd + remainingReservationUsd;
        let dayTotalUsd = conservativeUsageUsd;
        if (current.budget_day) {
          const totals = await tx.execute<{
            breaker_usage_usd: string;
          }>(sql`
            update browser_observation_budget_days
            set reserved_usd = greatest(0, reserved_usd - ${remainingReservationUsd}),
                usage_usd = usage_usd + ${remainingReservationUsd},
                updated_at = ${at}
            where budget_day = ${current.budget_day}::date
            returning (usage_usd + reserved_usd)::text as breaker_usage_usd
          `);
          dayTotalUsd = Number(
            totals.rows[0]?.breaker_usage_usd ?? conservativeUsageUsd,
          );
        }
        await tx
          .update(browserObservations)
          .set({
            usageUsd: String(conservativeUsageUsd),
            budgetReservedUsd: "0",
            usageReconciledAt: at,
            updatedAt: at,
          })
          .where(eq(browserObservations.id, observationId));
        return {
          state: remainingReservationUsd > 0 ? "updated" : "unchanged",
          deltaUsd: remainingReservationUsd,
          dayTotalUsd,
        };
      });
    },

    async listReconciliationCandidates(
      now = new Date(),
      limit = 100,
    ): Promise<BrowserObservationJobV1[]> {
      const rows = await db
        .select({
          observation_id: browserObservations.id,
          operation_id: browserObservations.operationId,
        })
        .from(browserObservations)
        .where(
          or(
            eq(browserObservations.status, "queued"),
            and(
              inArray(browserObservations.status, ["starting", "running"]),
              or(
                lt(browserObservations.leaseExpiresAt, now),
                sql`${browserObservations.leaseExpiresAt} is null`,
              ),
            ),
          ),
        )
        .orderBy(asc(browserObservations.queuedAt))
        .limit(Math.min(1_000, Math.max(1, limit)));
      return rows.map((row) => ({ ...row, attempt_no: 1 as const }));
    },

    async dailyUsageUsd(now = new Date()): Promise<number> {
      const result = await db.execute<{ usage: string }>(sql`
        select coalesce(usage_usd + reserved_usd, 0)::text as usage
        from browser_observation_budget_days
        where budget_day = ${utcBudgetDay(now)}::date
      `);
      return Number(result.rows[0]?.usage ?? 0);
    },

    async listCleanupCandidates(
      now = new Date(),
      limit = 100,
    ): Promise<BrowserObservationCleanupCandidate[]> {
      const cleanupCutoff = new Date(now.getTime() - 5 * 60_000);
      const rows = await db
        .select({
          observationId: browserObservations.id,
          operationId: browserObservations.operationId,
          actorId: browserObservations.actorId,
          apifyRunId: browserObservations.apifyRunId,
        })
        .from(browserObservations)
        .where(
          and(
            inArray(browserObservations.status, TERMINAL_STATUSES),
            isNull(browserObservations.storageCleanedAt),
            lt(browserObservations.finishedAt, cleanupCutoff),
          ),
        )
        .orderBy(asc(browserObservations.finishedAt))
        .limit(Math.min(1_000, Math.max(1, limit)));
      return rows;
    },

    async listUsageReconciliationCandidates(
      now = new Date(),
      limit = 100,
    ): Promise<BrowserObservationUsageCandidate[]> {
      const usageCutoff = new Date(now.getTime() - 30 * 60_000);
      return await db
        .select({
          observationId: browserObservations.id,
          operationId: browserObservations.operationId,
          actorId: browserObservations.actorId,
          apifyRunId: browserObservations.apifyRunId,
        })
        .from(browserObservations)
        .where(
          and(
            inArray(browserObservations.status, TERMINAL_STATUSES),
            isNull(browserObservations.usageReconciledAt),
            lt(browserObservations.finishedAt, usageCutoff),
          ),
        )
        .orderBy(asc(browserObservations.finishedAt))
        .limit(Math.min(1_000, Math.max(1, limit)));
    },

    async markStorageCleaned(
      observationId: string,
      runId: string,
      at = new Date(),
    ): Promise<boolean> {
      const rows = await db
        .update(browserObservations)
        .set({
          apifyRunId: runId,
          storageCleanedAt: at,
          updatedAt: at,
        })
        .where(
          and(
            eq(browserObservations.id, observationId),
            isNull(browserObservations.storageCleanedAt),
            or(
              isNull(browserObservations.apifyRunId),
              eq(browserObservations.apifyRunId, runId),
            ),
          ),
        )
        .returning({ id: browserObservations.id });
      return rows.length === 1;
    },

    async getForScan(scanId: string): Promise<BrowserObservationRecord | null> {
      const [row] = await db
        .select()
        .from(browserObservations)
        .where(
          and(
            eq(browserObservations.scanId, scanId),
            eq(
              browserObservations.observationVersion,
              BROWSER_OBSERVATION_VERSION,
            ),
          ),
        )
        .limit(1);
      if (!row) return null;
      const findings = await db
        .select()
        .from(browserObservationFindings)
        .where(eq(browserObservationFindings.observationId, row.id));
      return {
        id: row.id,
        version: BROWSER_OBSERVATION_VERSION,
        actorBuild: row.actorBuild,
        status: row.status,
        pagesAssessed: row.pagesAssessed,
        signals: row.signals
          ? browserObservationSignalsSchema.parse(row.signals)
          : null,
        findings: findings.map((finding) =>
          browserObservationFindingSchema.parse({
            id: finding.findingId,
            status: finding.status,
            summary_code: finding.summaryCode,
            ...(finding.userImpactCode
              ? { user_impact_code: finding.userImpactCode }
              : {}),
            ...(finding.remediationCode
              ? { remediation_code: finding.remediationCode }
              : {}),
            evidence: finding.evidence,
          }),
        ),
        updatedAt: row.updatedAt,
      };
    },
  };
}
