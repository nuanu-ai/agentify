import { describe, expect, it, vi } from "vitest";

import type { BrowserProviderClient } from "./apify-browser-client.js";
import { cleanupBrowserObservationOrphans } from "./browser-observation-janitor.js";
import type { BrowserObservationRepository } from "./browser-observation-job.js";

describe("browser observation orphan janitor", () => {
  it("finds an unattached run by operation ID and cleans its storage", async () => {
    const repository = {
      listCleanupCandidates: vi.fn().mockResolvedValue([
        {
          observationId: "019b41a0-7c51-7d63-84bd-a5a20faef491",
          operationId: "019b41a0-7c51-7d63-84bd-a5a20faef493",
          actorId: "owner/actor",
          apifyRunId: null,
        },
      ]),
      listUsageReconciliationCandidates: vi.fn().mockResolvedValue([
        {
          observationId: "019b41a0-7c51-7d63-84bd-a5a20faef491",
          operationId: "019b41a0-7c51-7d63-84bd-a5a20faef493",
          actorId: "owner/actor",
          apifyRunId: "orphan-run",
        },
      ]),
      reconcileUsage: vi.fn().mockResolvedValue({
        state: "updated",
        deltaUsd: 0.001,
        dayTotalUsd: 0.011,
      }),
      settleUsageConservatively: vi.fn(),
      markStorageCleaned: vi.fn().mockResolvedValue(true),
    } as unknown as BrowserObservationRepository;
    const provider = {
      findRecentRun: vi
        .fn()
        .mockResolvedValue({ id: "orphan-run", status: "SUCCEEDED" }),
      abort: vi.fn().mockResolvedValue(undefined),
      getUsage: vi.fn().mockResolvedValue(0.011),
      cleanup: vi.fn().mockResolvedValue(undefined),
    } as unknown as BrowserProviderClient;

    await expect(
      cleanupBrowserObservationOrphans({ repository, provider }),
    ).resolves.toBe(1);
    expect(provider.findRecentRun).toHaveBeenCalledOnce();
    expect(provider.cleanup).toHaveBeenCalledWith("orphan-run");
    expect(repository.reconcileUsage).toHaveBeenCalledWith(
      "019b41a0-7c51-7d63-84bd-a5a20faef491",
      "orphan-run",
      0.011,
      expect.any(Date),
    );
    expect(repository.markStorageCleaned).toHaveBeenCalledWith(
      "019b41a0-7c51-7d63-84bd-a5a20faef491",
      "orphan-run",
      expect.any(Date),
    );
  });

  it("leaves a failed cleanup pending for the next janitor pass", async () => {
    const onCleanupError = vi.fn();
    const repository = {
      listCleanupCandidates: vi.fn().mockResolvedValue([
        {
          observationId: "019b41a0-7c51-7d63-84bd-a5a20faef491",
          operationId: "019b41a0-7c51-7d63-84bd-a5a20faef493",
          actorId: "owner/actor",
          apifyRunId: "run-1",
        },
      ]),
      listUsageReconciliationCandidates: vi.fn().mockResolvedValue([]),
      reconcileUsage: vi.fn().mockResolvedValue({
        state: "unchanged",
        deltaUsd: 0,
        dayTotalUsd: 0.01,
      }),
      settleUsageConservatively: vi.fn(),
      markStorageCleaned: vi.fn(),
    } as unknown as BrowserObservationRepository;
    const provider = {
      abort: vi.fn().mockResolvedValue(undefined),
      getUsage: vi.fn().mockResolvedValue(0.01),
      cleanup: vi.fn().mockRejectedValue(new Error("provider_down")),
    } as unknown as BrowserProviderClient;

    await expect(
      cleanupBrowserObservationOrphans({
        repository,
        provider,
        onCleanupError,
      }),
    ).resolves.toBe(0);
    expect(repository.markStorageCleaned).not.toHaveBeenCalled();
    expect(onCleanupError).toHaveBeenCalledWith(
      "019b41a0-7c51-7d63-84bd-a5a20faef491",
    );
  });

  it("reconciles delayed final usage without repeating storage cleanup", async () => {
    const onBudgetExceeded = vi.fn();
    const repository = {
      listCleanupCandidates: vi.fn().mockResolvedValue([]),
      listUsageReconciliationCandidates: vi.fn().mockResolvedValue([
        {
          observationId: "019b41a0-7c51-7d63-84bd-a5a20faef491",
          operationId: "019b41a0-7c51-7d63-84bd-a5a20faef493",
          actorId: "owner/actor",
          apifyRunId: "run-1",
        },
      ]),
      reconcileUsage: vi.fn().mockResolvedValue({
        state: "updated",
        deltaUsd: 0.000045,
        dayTotalUsd: 25.000001,
      }),
      settleUsageConservatively: vi.fn(),
      markStorageCleaned: vi.fn(),
    } as unknown as BrowserObservationRepository;
    const provider = {
      getUsage: vi.fn().mockResolvedValue(0.002566),
      abort: vi.fn(),
      cleanup: vi.fn(),
    } as unknown as BrowserProviderClient;

    await expect(
      cleanupBrowserObservationOrphans({
        repository,
        provider,
        now: new Date("2026-07-13T01:00:00.000Z"),
        dailyBudgetUsd: 25,
        onBudgetExceeded,
      }),
    ).resolves.toBe(0);
    expect(repository.reconcileUsage).toHaveBeenCalledWith(
      "019b41a0-7c51-7d63-84bd-a5a20faef491",
      "run-1",
      0.002566,
      new Date("2026-07-13T01:00:00.000Z"),
    );
    expect(provider.cleanup).not.toHaveBeenCalled();
    expect(repository.markStorageCleaned).not.toHaveBeenCalled();
    expect(onBudgetExceeded).toHaveBeenCalledWith(
      "019b41a0-7c51-7d63-84bd-a5a20faef491",
      25.000001,
    );
  });

  it("finishes storage cleanup before a failed usage reconciliation", async () => {
    const repository = {
      listCleanupCandidates: vi.fn().mockResolvedValue([
        {
          observationId: "019b41a0-7c51-7d63-84bd-a5a20faef491",
          operationId: "019b41a0-7c51-7d63-84bd-a5a20faef493",
          actorId: "owner/actor",
          apifyRunId: "cleanup-run",
        },
      ]),
      listUsageReconciliationCandidates: vi.fn().mockResolvedValue([
        {
          observationId: "019b41a0-7c51-7d63-84bd-a5a20faef492",
          operationId: "019b41a0-7c51-7d63-84bd-a5a20faef494",
          actorId: "owner/actor",
          apifyRunId: "usage-run",
        },
      ]),
      reconcileUsage: vi.fn(),
      settleUsageConservatively: vi.fn().mockResolvedValue({
        state: "updated",
        deltaUsd: 0.05,
        dayTotalUsd: 0.05,
      }),
      markStorageCleaned: vi.fn().mockResolvedValue(true),
    } as unknown as BrowserObservationRepository;
    const cleanup = vi.fn().mockResolvedValue(undefined);
    const getUsage = vi.fn().mockRejectedValue(new Error("provider_down"));
    const provider = {
      abort: vi.fn().mockResolvedValue(undefined),
      cleanup,
      getUsage,
    } as unknown as BrowserProviderClient;

    await expect(
      cleanupBrowserObservationOrphans({ repository, provider }),
    ).resolves.toBe(1);
    expect(repository.markStorageCleaned).toHaveBeenCalledOnce();
    expect(repository.settleUsageConservatively).toHaveBeenCalledOnce();
    expect(cleanup.mock.invocationCallOrder[0]).toBeLessThan(
      getUsage.mock.invocationCallOrder[0]!,
    );
  });
});
