import {
  BROWSER_OBSERVATION_VERSION,
  browserObservationJobV1Schema,
  type BrowserObservationInputV1,
  type BrowserObservationJobV1,
} from "@b2a/contracts";
import type {
  createBrowserObservationRepository,
  BrowserObservationClaim,
} from "@b2a/db";
import { getDomain } from "tldts";

import type { BrowserProviderClient } from "./apify-browser-client.js";

export type BrowserObservationRepository = ReturnType<
  typeof createBrowserObservationRepository
>;

export type BrowserObservationJobConfig = {
  timeoutSeconds: number;
  maxRunUsd: number;
  dailyBudgetUsd: number;
  maxPages: number;
};

export type BrowserObservationMetric =
  | { name: "browser_observation_started_total"; value: 1 }
  | { name: "browser_observation_terminal_total"; value: 1; status: string }
  | { name: "browser_observation_cleanup_failure_total"; value: 1 }
  | { name: "browser_observation_unknown_run_total"; value: 1 };

const canonicalPublicUrl = (raw: string): string => {
  const url = new URL(raw);
  url.username = "";
  url.password = "";
  url.search = "";
  url.hash = "";
  return url.toString();
};

export const buildBrowserObservationInput = (
  observation: BrowserObservationClaim,
  config: BrowserObservationJobConfig,
): BrowserObservationInputV1 => {
  const canonicalUrl = canonicalPublicUrl(observation.canonicalTargetUrl);
  const host = new URL(canonicalUrl).hostname;
  return {
    schema_version: BROWSER_OBSERVATION_VERSION,
    operation_id: observation.operationId,
    target: {
      canonical_url: canonicalUrl,
      registrable_domain:
        getDomain(host, { allowPrivateDomains: true }) ??
        getDomain(host, { allowPrivateDomains: false }) ??
        host,
      segment: observation.segment,
    },
    representative_urls: [],
    policy: {
      user_agent:
        "agentify-browser-observer/1.0 (+https://agentify.ad/scanner)",
      methods: ["GET", "HEAD"],
      use_proxy: false,
      respect_robots: true,
      crawl_purpose: "search",
    },
    limits: {
      max_pages: config.maxPages,
      max_requests_per_page: 80,
      max_total_bytes: 8 * 1024 * 1024,
      page_timeout_ms: 12_000,
      run_timeout_ms: 45_000,
    },
  };
};

const safeFailureCode = (error: unknown): string => {
  if (!(error instanceof Error)) return "browser_provider_error";
  const known = new Set([
    "apify_output_missing",
    "apify_storage_cleanup_failed",
  ]);
  return known.has(error.message) ? error.message : "browser_provider_error";
};

export async function processBrowserObservationJob(
  untrustedJob: BrowserObservationJobV1,
  dependencies: {
    repository: BrowserObservationRepository;
    provider: BrowserProviderClient;
    config: BrowserObservationJobConfig;
    now?: () => Date;
    emitMetric?: (metric: BrowserObservationMetric) => void;
  },
): Promise<"committed" | "skipped"> {
  const job = browserObservationJobV1Schema.parse(untrustedJob);
  const now = dependencies.now ?? (() => new Date());
  const leaseMs = Math.max(
    90_000,
    (dependencies.config.timeoutSeconds + 30) * 1_000,
  );
  const claim = await dependencies.repository.claim(job, now(), leaseMs);
  if (claim.state !== "claimed") return "skipped";
  const observation = claim.observation;
  const leaseToken = observation.leaseToken;
  let runId = observation.apifyRunId;
  let runUsageUsd: number | undefined;
  const heartbeat = setInterval(
    () => {
      void dependencies.repository
        .heartbeat(observation.id, leaseToken, now(), leaseMs)
        .catch(() => undefined);
    },
    Math.min(15_000, Math.max(5_000, Math.floor(leaseMs / 3))),
  );
  heartbeat.unref();
  try {
    if (!runId && observation.resuming) {
      const reconciliationExpired =
        now().getTime() - observation.startedAt.getTime() >=
        6 * 60 * 60 * 1_000;
      try {
        const match = await dependencies.provider.findRecentRun(
          observation.actorId,
          observation.operationId,
          new Date(now().getTime() - 6 * 60 * 60 * 1_000),
        );
        if (!match) {
          dependencies.emitMetric?.({
            name: "browser_observation_unknown_run_total",
            value: 1,
          });
          if (reconciliationExpired)
            await dependencies.repository.markTerminal(
              observation.id,
              leaseToken,
              "failed",
              "unknown_run_state",
              { at: now() },
            );
          return "skipped";
        }
        runId = match.id;
      } catch {
        if (reconciliationExpired)
          await dependencies.repository.markTerminal(
            observation.id,
            leaseToken,
            "failed",
            "unknown_run_state",
            { at: now() },
          );
        return "skipped";
      }
    }

    if (!runId) {
      const budget = await dependencies.repository.reserveDailyBudget(
        observation.id,
        leaseToken,
        dependencies.config.maxRunUsd,
        dependencies.config.dailyBudgetUsd,
        now(),
      );
      if (budget === "fenced") return "skipped";
      if (budget === "exhausted") {
        await dependencies.repository.markTerminal(
          observation.id,
          leaseToken,
          "budget_skipped",
          "daily_budget_exhausted",
          { at: now(), usageUsd: 0 },
        );
        dependencies.emitMetric?.({
          name: "browser_observation_terminal_total",
          value: 1,
          status: "budget_skipped",
        });
        return "skipped";
      }
      try {
        const run = await dependencies.provider.start(
          observation.actorId,
          observation.actorBuild,
          buildBrowserObservationInput(observation, dependencies.config),
          {
            timeoutSeconds: dependencies.config.timeoutSeconds,
            maxRunUsd: dependencies.config.maxRunUsd,
          },
        );
        runId = run.id;
        dependencies.emitMetric?.({
          name: "browser_observation_started_total",
          value: 1,
        });
      } catch {
        // The provider may have accepted the paid run before the transport failed.
        // Keep the leased row reconcileable; never classify this as proven pre-start.
        dependencies.emitMetric?.({
          name: "browser_observation_unknown_run_total",
          value: 1,
        });
        return "skipped";
      }
    }

    const attachState = await dependencies.repository.attachRun(
      observation.id,
      leaseToken,
      runId,
      now(),
      leaseMs,
    );
    if (attachState !== "attached") {
      if (attachState === "owned_elsewhere") {
        runId = null;
        return "skipped";
      }
      await dependencies.provider.abort(runId).catch(() => undefined);
      await dependencies.provider.cleanup(runId).catch(() => {
        dependencies.emitMetric?.({
          name: "browser_observation_cleanup_failure_total",
          value: 1,
        });
      });
      runId = null;
      return "skipped";
    }

    const run = await dependencies.provider.waitForFinish(
      runId,
      dependencies.config.timeoutSeconds,
    );
    runUsageUsd = run.usageUsd;
    const stillOwned = await dependencies.repository.heartbeat(
      observation.id,
      leaseToken,
      now(),
      leaseMs,
    );
    if (!stillOwned) {
      runId = null;
      return "skipped";
    }
    if (run.status === "RUNNING" || run.status === "READY") {
      await dependencies.provider.abort(runId).catch(() => undefined);
      const marked = await dependencies.repository.markTerminal(
        observation.id,
        leaseToken,
        "failed",
        "apify_timeout",
        {
          at: now(),
          usageUsd: Math.max(runUsageUsd ?? 0, dependencies.config.maxRunUsd),
        },
      );
      if (!marked) runId = null;
      return "skipped";
    }
    if (run.status !== "SUCCEEDED") {
      const marked = await dependencies.repository.markTerminal(
        observation.id,
        leaseToken,
        "failed",
        `apify_${run.status.toLowerCase().replaceAll("-", "_")}`,
        { at: now(), usageUsd: runUsageUsd },
      );
      if (!marked) runId = null;
      return "skipped";
    }
    const output = await dependencies.provider.getOutput(runId);
    if (output.actor_build !== observation.actorBuild) {
      const marked = await dependencies.repository.markTerminal(
        observation.id,
        leaseToken,
        "failed",
        "actor_build_mismatch",
        { at: now(), usageUsd: runUsageUsd },
      );
      if (!marked) runId = null;
      return "skipped";
    }
    const committed = await dependencies.repository.complete(
      observation.id,
      leaseToken,
      output,
      { usageUsd: runUsageUsd, finishedAt: now() },
    );
    if (committed !== "committed") {
      runId = null;
      return "skipped";
    }
    dependencies.emitMetric?.({
      name: "browser_observation_terminal_total",
      value: 1,
      status: output.status,
    });
    return "committed";
  } catch (error) {
    // Once a run ID is attached, a transport/API error does not prove the
    // provider run stopped. Abort before marking/cleanup so a live Actor cannot
    // recreate storage after storage_cleaned_at is recorded.
    if (runId) {
      await dependencies.provider.abort(runId).catch(() => undefined);
    }
    const marked = await dependencies.repository.markTerminal(
      observation.id,
      leaseToken,
      "failed",
      safeFailureCode(error),
      { at: now(), usageUsd: runUsageUsd },
    );
    if (!marked) runId = null;
    return "skipped";
  } finally {
    clearInterval(heartbeat);
    if (runId) {
      let cleaned = true;
      await dependencies.provider.cleanup(runId).catch(() => {
        cleaned = false;
        dependencies.emitMetric?.({
          name: "browser_observation_cleanup_failure_total",
          value: 1,
        });
      });
      if (cleaned)
        await dependencies.repository
          .markStorageCleaned(observation.id, runId, now())
          .catch(() => undefined);
    }
  }
}

export interface BrowserObservationBoss {
  work<T>(
    name: string,
    options: {
      localConcurrency: number;
      batchSize: 1;
      includeMetadata: true;
    },
    handler: (jobs: Array<{ data: T }>) => Promise<void>,
  ): Promise<string>;
}

export async function registerBrowserObservationWorker(
  boss: BrowserObservationBoss,
  dependencies: Parameters<typeof processBrowserObservationJob>[1],
  concurrency = 1,
): Promise<string> {
  return await boss.work<BrowserObservationJobV1>(
    "browser-observation-v1",
    { localConcurrency: concurrency, batchSize: 1, includeMetadata: true },
    async (jobs) => {
      for (const job of jobs)
        await processBrowserObservationJob(job.data, dependencies);
    },
  );
}
