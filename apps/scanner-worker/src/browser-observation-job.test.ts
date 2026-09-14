import {
  BROWSER_OBSERVATION_VERSION,
  type BrowserObservationOutputV1,
} from "@agentify/scanner-contracts";
import { describe, expect, it, vi } from "vitest";

import type { BrowserProviderClient } from "./apify-browser-client";
import {
  buildBrowserObservationInput,
  processBrowserObservationJob,
  type BrowserObservationRepository,
} from "./browser-observation-job";

const observation = {
  id: "019b41a0-7c51-7d63-84bd-a5a20faef491",
  scanId: "019b41a0-7c51-7d63-84bd-a5a20faef492",
  operationId: "019b41a0-7c51-7d63-84bd-a5a20faef493",
  canonicalTargetUrl: "https://shop.example.com/products?a=secret#fragment",
  registrableDomain: "shop.example.com",
  segment: "store" as const,
  actorId: "owner/actor",
  actorBuild: "1.0.42",
  apifyRunId: null,
  leaseToken: "019b41a0-7c51-7d63-84bd-a5a20faef494",
  startedAt: new Date("2026-07-13T00:00:00.000Z"),
  resuming: false,
};

const config = {
  timeoutSeconds: 60,
  maxRunUsd: 0.05,
  dailyBudgetUsd: 25,
  maxPages: 3,
};

const output: BrowserObservationOutputV1 = {
  schema_version: BROWSER_OBSERVATION_VERSION,
  operation_id: observation.operationId,
  actor_build: observation.actorBuild,
  status: "completed",
  pages_assessed: 1,
  signals: {
    rendered_text_chars: 100,
    raw_to_rendered_ratio: 1,
    landmark_counts: { main: 1 },
    heading_level_counts: { h1: 1 },
    interactive_control_count: 0,
    unnamed_control_count: 0,
    form_control_count: 0,
    unlabeled_form_control_count: 0,
    webmcp_present: false,
    webmcp_tool_count: 0,
    console_error_categories: [],
    failed_resource_categories: [],
    mixed_content_count: 0,
    dom_node_count: 10,
    script_count: 1,
    request_count: 2,
    transferred_bytes: 1_024,
    challenge_kind: null,
  },
  observations: [],
  timings: { total_ms: 100, pages: [100] },
};

function repository(
  overrides: Partial<BrowserObservationRepository> = {},
): BrowserObservationRepository {
  return {
    claim: vi.fn().mockResolvedValue({ state: "claimed", observation }),
    attachRun: vi.fn().mockResolvedValue("attached"),
    heartbeat: vi.fn().mockResolvedValue(true),
    complete: vi.fn().mockResolvedValue("committed"),
    markTerminal: vi.fn().mockResolvedValue(undefined),
    listReconciliationCandidates: vi.fn().mockResolvedValue([]),
    dailyUsageUsd: vi.fn().mockResolvedValue(0),
    reserveDailyBudget: vi.fn().mockResolvedValue("reserved"),
    listCleanupCandidates: vi.fn().mockResolvedValue([]),
    listUsageReconciliationCandidates: vi.fn().mockResolvedValue([]),
    reconcileUsage: vi.fn().mockResolvedValue({
      state: "unchanged",
      deltaUsd: 0,
      dayTotalUsd: 0,
    }),
    settleUsageConservatively: vi.fn().mockResolvedValue({
      state: "unchanged",
      deltaUsd: 0,
      dayTotalUsd: 0,
    }),
    markStorageCleaned: vi.fn().mockResolvedValue(true),
    getForScan: vi.fn().mockResolvedValue(null),
    ...overrides,
  } as BrowserObservationRepository;
}

function provider(
  overrides: Partial<BrowserProviderClient> = {},
): BrowserProviderClient {
  return {
    start: vi.fn().mockResolvedValue({ id: "run-1" }),
    findRecentRun: vi.fn().mockResolvedValue(null),
    waitForFinish: vi
      .fn()
      .mockResolvedValue({ id: "run-1", status: "SUCCEEDED", usageUsd: 0.01 }),
    getUsage: vi.fn().mockResolvedValue(0.01),
    getOutput: vi.fn().mockResolvedValue(output),
    abort: vi.fn().mockResolvedValue(undefined),
    cleanup: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe("browser observation job", () => {
  it("strips query/fragment and preserves strict passive limits", () => {
    const input = buildBrowserObservationInput(observation, config);
    expect(input.target.canonical_url).toBe(
      "https://shop.example.com/products",
    );
    expect(input.target.registrable_domain).toBe("example.com");
    expect(input.policy.methods).toEqual(["GET", "HEAD"]);
    expect(input.policy.use_proxy).toBe(false);
    expect(input.limits.max_pages).toBe(3);
  });

  it("keeps private-suffix tenants in separate site boundaries", () => {
    const input = buildBrowserObservationInput(
      {
        ...observation,
        canonicalTargetUrl: "https://foo.github.io/docs?secret=value",
      },
      config,
    );

    expect(input.target.registrable_domain).toBe("foo.github.io");
  });

  it("starts, persists, validates and cleans a successful run", async () => {
    const repo = repository();
    const apify = provider();
    await expect(
      processBrowserObservationJob(
        {
          observation_id: observation.id,
          operation_id: observation.operationId,
          attempt_no: 1,
        },
        { repository: repo, provider: apify, config },
      ),
    ).resolves.toBe("committed");
    expect(apify.start).toHaveBeenCalledOnce();
    expect(repo.attachRun).toHaveBeenCalledWith(
      observation.id,
      observation.leaseToken,
      "run-1",
      expect.any(Date),
      90_000,
    );
    expect(repo.complete).toHaveBeenCalledOnce();
    expect(apify.cleanup).toHaveBeenCalledWith("run-1");
  });

  it("aborts an attached run before cleanup when provider wait is ambiguous", async () => {
    const repo = repository({
      markTerminal: vi.fn().mockResolvedValue(true),
    });
    const apify = provider({
      waitForFinish: vi.fn().mockRejectedValue(new Error("provider_transport")),
    });

    await expect(
      processBrowserObservationJob(
        {
          observation_id: observation.id,
          operation_id: observation.operationId,
          attempt_no: 1,
        },
        { repository: repo, provider: apify, config },
      ),
    ).resolves.toBe("skipped");

    expect(apify.abort).toHaveBeenCalledWith("run-1");
    expect(apify.cleanup).toHaveBeenCalledWith("run-1");
    expect(repo.markTerminal).toHaveBeenCalledOnce();
    expect(repo.markStorageCleaned).toHaveBeenCalledOnce();
    expect(vi.mocked(apify.abort).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(apify.cleanup).mock.invocationCallOrder[0] ?? 0,
    );
  });

  it("stops before provider start when the daily budget is exhausted", async () => {
    const repo = repository({
      reserveDailyBudget: vi.fn().mockResolvedValue("exhausted"),
    });
    const apify = provider();
    await processBrowserObservationJob(
      {
        observation_id: observation.id,
        operation_id: observation.operationId,
        attempt_no: 1,
      },
      { repository: repo, provider: apify, config },
    );
    expect(apify.start).not.toHaveBeenCalled();
    expect(repo.markTerminal).toHaveBeenCalledWith(
      observation.id,
      observation.leaseToken,
      "budget_skipped",
      "daily_budget_exhausted",
      { at: expect.any(Date), usageUsd: 0 },
    );
  });

  it("rejects output from an unexpected Actor build", async () => {
    const repo = repository();
    const apify = provider({
      getOutput: vi.fn().mockResolvedValue({
        ...output,
        actor_build: "1.0.999",
      }),
    });
    await processBrowserObservationJob(
      {
        observation_id: observation.id,
        operation_id: observation.operationId,
        attempt_no: 1,
      },
      { repository: repo, provider: apify, config },
    );
    expect(repo.complete).not.toHaveBeenCalled();
    expect(repo.markTerminal).toHaveBeenCalledWith(
      observation.id,
      observation.leaseToken,
      "failed",
      "actor_build_mismatch",
      { at: expect.any(Date), usageUsd: 0.01 },
    );
  });

  it("does not create a duplicate paid run when stale state is unknown", async () => {
    const repo = repository({
      claim: vi.fn().mockResolvedValue({
        state: "claimed",
        observation: {
          ...observation,
          startedAt: new Date("2020-01-01T00:00:00.000Z"),
          resuming: true,
        },
      }),
    });
    const apify = provider({ findRecentRun: vi.fn().mockResolvedValue(null) });
    await processBrowserObservationJob(
      {
        observation_id: observation.id,
        operation_id: observation.operationId,
        attempt_no: 1,
      },
      { repository: repo, provider: apify, config },
    );
    expect(apify.start).not.toHaveBeenCalled();
    expect(repo.markTerminal).toHaveBeenCalledWith(
      observation.id,
      observation.leaseToken,
      "failed",
      "unknown_run_state",
      { at: expect.any(Date) },
    );
  });

  it("keeps a recent missing run reconcileable across transient list lag", async () => {
    const current = new Date("2026-07-13T00:05:00.000Z");
    const repo = repository({
      claim: vi.fn().mockResolvedValue({
        state: "claimed",
        observation: {
          ...observation,
          startedAt: new Date("2026-07-13T00:00:00.000Z"),
          resuming: true,
        },
      }),
    });
    const apify = provider({ findRecentRun: vi.fn().mockResolvedValue(null) });
    await processBrowserObservationJob(
      {
        observation_id: observation.id,
        operation_id: observation.operationId,
        attempt_no: 1,
      },
      { repository: repo, provider: apify, config, now: () => current },
    );
    expect(apify.start).not.toHaveBeenCalled();
    expect(repo.markTerminal).not.toHaveBeenCalled();
  });

  it("keeps a recent reconciliation provider error retryable", async () => {
    const current = new Date("2026-07-13T00:05:00.000Z");
    const repo = repository({
      claim: vi.fn().mockResolvedValue({
        state: "claimed",
        observation: {
          ...observation,
          startedAt: new Date("2026-07-13T00:00:00.000Z"),
          resuming: true,
        },
      }),
    });
    const apify = provider({
      findRecentRun: vi.fn().mockRejectedValue(new Error("provider_503")),
    });
    await processBrowserObservationJob(
      {
        observation_id: observation.id,
        operation_id: observation.operationId,
        attempt_no: 1,
      },
      { repository: repo, provider: apify, config, now: () => current },
    );
    expect(apify.start).not.toHaveBeenCalled();
    expect(repo.markTerminal).not.toHaveBeenCalled();
  });

  it("keeps an ambiguous provider start reconcileable", async () => {
    const repo = repository();
    const apify = provider({
      start: vi.fn().mockRejectedValue(new Error("transport_reset")),
    });
    await expect(
      processBrowserObservationJob(
        {
          observation_id: observation.id,
          operation_id: observation.operationId,
          attempt_no: 1,
        },
        { repository: repo, provider: apify, config },
      ),
    ).resolves.toBe("skipped");
    expect(repo.reserveDailyBudget).toHaveBeenCalledOnce();
    expect(repo.markTerminal).not.toHaveBeenCalled();
    expect(apify.cleanup).not.toHaveBeenCalled();
  });

  it("aborts and cleans a run that loses the attach fence", async () => {
    const repo = repository({ attachRun: vi.fn().mockResolvedValue("fenced") });
    const apify = provider();
    await processBrowserObservationJob(
      {
        observation_id: observation.id,
        operation_id: observation.operationId,
        attempt_no: 1,
      },
      { repository: repo, provider: apify, config },
    );
    expect(apify.abort).toHaveBeenCalledWith("run-1");
    expect(apify.cleanup).toHaveBeenCalledTimes(1);
    expect(repo.markStorageCleaned).not.toHaveBeenCalled();
  });

  it("does not disrupt a run already attached by the current lease owner", async () => {
    const repo = repository({
      attachRun: vi.fn().mockResolvedValue("owned_elsewhere"),
    });
    const apify = provider();
    await processBrowserObservationJob(
      {
        observation_id: observation.id,
        operation_id: observation.operationId,
        attempt_no: 1,
      },
      { repository: repo, provider: apify, config },
    );
    expect(apify.abort).not.toHaveBeenCalled();
    expect(apify.cleanup).not.toHaveBeenCalled();
  });

  it("reconciles provider usage for a failed paid run", async () => {
    const repo = repository();
    const apify = provider({
      waitForFinish: vi.fn().mockResolvedValue({
        id: "run-1",
        status: "TIMED-OUT",
        usageUsd: 0.037,
      }),
    });
    await processBrowserObservationJob(
      {
        observation_id: observation.id,
        operation_id: observation.operationId,
        attempt_no: 1,
      },
      { repository: repo, provider: apify, config },
    );
    expect(repo.markTerminal).toHaveBeenCalledWith(
      observation.id,
      observation.leaseToken,
      "failed",
      "apify_timed_out",
      { at: expect.any(Date), usageUsd: 0.037 },
    );
  });
});
