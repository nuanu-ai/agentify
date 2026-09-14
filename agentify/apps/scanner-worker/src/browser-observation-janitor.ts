import type { BrowserProviderClient } from "./apify-browser-client.js";
import type { BrowserObservationRepository } from "./browser-observation-job.js";

export async function cleanupBrowserObservationOrphans(input: {
  repository: BrowserObservationRepository;
  provider: BrowserProviderClient;
  now?: Date;
  limit?: number;
  usageLimit?: number;
  dailyBudgetUsd?: number;
  onCleanupError?: (observationId: string) => void;
  onUsageError?: (observationId: string) => void;
  onBudgetExceeded?: (observationId: string, dayTotalUsd: number) => void;
}): Promise<number> {
  const now = input.now ?? new Date();
  const cleanupCandidates = await input.repository.listCleanupCandidates(
    now,
    input.limit,
  );
  let cleaned = 0;
  for (const candidate of cleanupCandidates) {
    try {
      const match = candidate.apifyRunId
        ? { id: candidate.apifyRunId }
        : await input.provider.findRecentRun(
            candidate.actorId,
            candidate.operationId,
            new Date(now.getTime() - 24 * 60 * 60 * 1_000),
          );
      if (!match) continue;
      await input.provider.abort(match.id).catch(() => undefined);
      await input.provider.cleanup(match.id);
      await input.repository.markStorageCleaned(
        candidate.observationId,
        match.id,
        now,
      );
      cleaned += 1;
    } catch {
      input.onCleanupError?.(candidate.observationId);
    }
  }

  const usageCandidates =
    await input.repository.listUsageReconciliationCandidates(
      now,
      input.usageLimit,
    );
  for (const candidate of usageCandidates) {
    let result: {
      state: "updated" | "unchanged" | "missing";
      deltaUsd: number;
      dayTotalUsd: number;
    };
    try {
      const match = candidate.apifyRunId
        ? { id: candidate.apifyRunId }
        : await input.provider.findRecentRun(
            candidate.actorId,
            candidate.operationId,
            new Date(now.getTime() - 24 * 60 * 60 * 1_000),
          );
      if (!match) throw new Error("provider_run_unavailable");
      const usageUsd = await input.provider.getUsage(match.id);
      if (usageUsd === undefined) throw new Error("provider_usage_unavailable");
      result = await input.repository.reconcileUsage(
        candidate.observationId,
        match.id,
        usageUsd,
        now,
      );
    } catch {
      input.onUsageError?.(candidate.observationId);
      try {
        result = await input.repository.settleUsageConservatively(
          candidate.observationId,
          now,
        );
      } catch {
        continue;
      }
    }
    if (
      result.state !== "missing" &&
      input.dailyBudgetUsd !== undefined &&
      result.dayTotalUsd > input.dailyBudgetUsd
    )
      input.onBudgetExceeded?.(candidate.observationId, result.dayTotalUsd);
  }
  return cleaned;
}

export function startBrowserObservationJanitor(input: {
  repository: BrowserObservationRepository;
  provider: BrowserProviderClient;
  intervalMs?: number;
  usageLimit?: number;
  dailyBudgetUsd?: number;
  onCleanupError?: (observationId: string) => void;
  onUsageError?: (observationId: string) => void;
  onBudgetExceeded?: (observationId: string, dayTotalUsd: number) => void;
  onError?: (error: unknown) => void;
}): () => void {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await cleanupBrowserObservationOrphans(input);
    } catch (error) {
      input.onError?.(error);
    } finally {
      running = false;
    }
  };
  void tick();
  const timer = setInterval(() => void tick(), input.intervalMs ?? 300_000);
  timer.unref();
  return () => clearInterval(timer);
}
