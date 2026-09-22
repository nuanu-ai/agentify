import { describe, expect, it } from "vitest";

import type { BrowserProviderClient } from "./apify-browser-client.js";
import { cleanupBrowserObservationOrphans } from "./browser-observation-janitor.js";
import type { BrowserObservationRepository } from "./browser-observation-job.js";

const cleanupCandidate = {
  observationId: "019b41a0-7c51-7d63-84bd-a5a20faef491",
  operationId: "019b41a0-7c51-7d63-84bd-a5a20faef493",
  actorId: "owner/actor",
  apifyRunId: "orphan-run",
};

describe("browser observation orphan janitor", () => {
  it("finds an unattached run, reconciles usage and marks storage clean", async () => {
    const persisted = {
      reconciliation: undefined as
        | { observationId: string; runId: string; usageUsd: number }
        | undefined,
      storageCleaned: false,
    };
    const providerState = { cleaned: [] as string[] };
    const repository = {
      listCleanupCandidates: async () => [{ ...cleanupCandidate, apifyRunId: null }],
      listUsageReconciliationCandidates: async () => [cleanupCandidate],
      reconcileUsage: async (observationId: string, runId: string, usageUsd: number) => {
        persisted.reconciliation = { observationId, runId, usageUsd };
        return { state: "updated", deltaUsd: 0.001, dayTotalUsd: 0.011 };
      },
      settleUsageConservatively: async () => ({
        state: "unchanged",
        deltaUsd: 0,
        dayTotalUsd: 0,
      }),
      markStorageCleaned: async () => {
        persisted.storageCleaned = true;
        return true;
      },
    } as unknown as BrowserObservationRepository;
    const provider = {
      findRecentRun: async () => ({ id: "orphan-run", status: "SUCCEEDED" }),
      abort: async () => undefined,
      getUsage: async () => 0.011,
      cleanup: async (runId: string) => {
        providerState.cleaned.push(runId);
      },
    } as unknown as BrowserProviderClient;

    await expect(cleanupBrowserObservationOrphans({ repository, provider })).resolves.toBe(1);
    expect(providerState.cleaned).toEqual(["orphan-run"]);
    expect(persisted).toEqual({
      reconciliation: {
        observationId: cleanupCandidate.observationId,
        runId: "orphan-run",
        usageUsd: 0.011,
      },
      storageCleaned: true,
    });
  });

  it("leaves a failed cleanup pending for the next janitor pass", async () => {
    const persisted = { storageCleaned: false, cleanupError: false };
    const repository = {
      listCleanupCandidates: async () => [{ ...cleanupCandidate, apifyRunId: "run-1" }],
      listUsageReconciliationCandidates: async () => [],
      reconcileUsage: async () => ({
        state: "unchanged",
        deltaUsd: 0,
        dayTotalUsd: 0.01,
      }),
      settleUsageConservatively: async () => ({
        state: "unchanged",
        deltaUsd: 0,
        dayTotalUsd: 0.01,
      }),
      markStorageCleaned: async () => {
        persisted.storageCleaned = true;
        return true;
      },
    } as unknown as BrowserObservationRepository;
    const provider = {
      abort: async () => undefined,
      getUsage: async () => 0.01,
      cleanup: async () => {
        throw new Error("provider_down");
      },
    } as unknown as BrowserProviderClient;

    await expect(
      cleanupBrowserObservationOrphans({
        repository,
        provider,
        onCleanupError: () => {
          persisted.cleanupError = true;
        },
      }),
    ).resolves.toBe(0);
    expect(persisted).toEqual({ storageCleaned: false, cleanupError: true });
  });

  it("reconciles delayed usage without repeating storage cleanup", async () => {
    const state = {
      reconciledUsageUsd: 0,
      cleanupAttempted: false,
      storageCleaned: false,
      exceededTotal: 0,
    };
    const repository = {
      listCleanupCandidates: async () => [],
      listUsageReconciliationCandidates: async () => [cleanupCandidate],
      reconcileUsage: async (_observationId: string, _runId: string, usageUsd: number) => {
        state.reconciledUsageUsd = usageUsd;
        return {
          state: "updated",
          deltaUsd: 0.000045,
          dayTotalUsd: 25.000001,
        };
      },
      settleUsageConservatively: async () => ({
        state: "unchanged",
        deltaUsd: 0,
        dayTotalUsd: 0,
      }),
      markStorageCleaned: async () => {
        state.storageCleaned = true;
        return true;
      },
    } as unknown as BrowserObservationRepository;
    const provider = {
      getUsage: async () => 0.002566,
      abort: async () => undefined,
      cleanup: async () => {
        state.cleanupAttempted = true;
      },
    } as unknown as BrowserProviderClient;

    await expect(
      cleanupBrowserObservationOrphans({
        repository,
        provider,
        now: new Date("2026-07-13T01:00:00.000Z"),
        dailyBudgetUsd: 25,
        onBudgetExceeded: (_observationId, total) => {
          state.exceededTotal = total;
        },
      }),
    ).resolves.toBe(0);
    expect(state).toEqual({
      reconciledUsageUsd: 0.002566,
      cleanupAttempted: false,
      storageCleaned: false,
      exceededTotal: 25.000001,
    });
  });

  it("finishes storage cleanup before conservative usage settlement", async () => {
    const lifecycle: string[] = [];
    const repository = {
      listCleanupCandidates: async () => [{ ...cleanupCandidate, apifyRunId: "cleanup-run" }],
      listUsageReconciliationCandidates: async () => [
        {
          ...cleanupCandidate,
          observationId: "019b41a0-7c51-7d63-84bd-a5a20faef492",
          apifyRunId: "usage-run",
        },
      ],
      reconcileUsage: async () => {
        throw new Error("usage should be settled conservatively");
      },
      settleUsageConservatively: async () => {
        lifecycle.push("settle");
        return { state: "updated", deltaUsd: 0.05, dayTotalUsd: 0.05 };
      },
      markStorageCleaned: async () => {
        lifecycle.push("mark-clean");
        return true;
      },
    } as unknown as BrowserObservationRepository;
    const provider = {
      abort: async () => undefined,
      cleanup: async () => {
        lifecycle.push("cleanup");
      },
      getUsage: async () => {
        lifecycle.push("usage-failed");
        throw new Error("provider_down");
      },
    } as unknown as BrowserProviderClient;

    await expect(cleanupBrowserObservationOrphans({ repository, provider })).resolves.toBe(1);
    expect(lifecycle).toEqual(["cleanup", "mark-clean", "usage-failed", "settle"]);
  });
});
