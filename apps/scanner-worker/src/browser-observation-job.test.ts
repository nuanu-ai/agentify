import {
  BROWSER_OBSERVATION_VERSION,
  type BrowserObservationOutputV1,
} from "@agentify/scanner-contracts";
import { describe, expect, it } from "vitest";

import type { BrowserProviderClient } from "./apify-browser-client";
import {
  type BrowserObservationRepository,
  buildBrowserObservationInput,
  processBrowserObservationJob,
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

function repositoryFake(overrides: Partial<BrowserObservationRepository> = {}) {
  const state = {
    attachedRun: undefined as string | undefined,
    completed: false,
    terminal: undefined as
      { status: string; reason: string; usageUsd?: number } | undefined,
    storageCleaned: false,
    reservations: 0,
  };
  const repo: BrowserObservationRepository = {
    claim: async () => ({ state: "claimed", observation }),
    attachRun: async (_observationId, _leaseToken, runId) => {
      state.attachedRun = runId;
      return "attached";
    },
    heartbeat: async () => true,
    complete: async () => {
      state.completed = true;
      return "committed";
    },
    markTerminal: async (
      _observationId,
      _leaseToken,
      status,
      reason,
      options,
    ) => {
      state.terminal = {
        status,
        reason,
        ...(options?.usageUsd === undefined
          ? {}
          : { usageUsd: options.usageUsd }),
      };
      return true;
    },
    listReconciliationCandidates: async () => [],
    dailyUsageUsd: async () => 0,
    reserveDailyBudget: async () => {
      state.reservations += 1;
      return "reserved";
    },
    listCleanupCandidates: async () => [],
    listUsageReconciliationCandidates: async () => [],
    reconcileUsage: async () => ({
      state: "unchanged",
      deltaUsd: 0,
      dayTotalUsd: 0,
    }),
    settleUsageConservatively: async () => ({
      state: "unchanged",
      deltaUsd: 0,
      dayTotalUsd: 0,
    }),
    markStorageCleaned: async () => {
      state.storageCleaned = true;
      return true;
    },
    getForScan: async () => null,
    ...overrides,
  };
  return { repo, state };
}

function providerFake(overrides: Partial<BrowserProviderClient> = {}) {
  const state = {
    started: false,
    aborted: [] as string[],
    cleaned: [] as string[],
    lifecycle: [] as string[],
  };
  const provider: BrowserProviderClient = {
    start: async () => {
      state.started = true;
      state.lifecycle.push("start");
      return { id: "run-1" };
    },
    findRecentRun: async () => null,
    waitForFinish: async () => ({
      id: "run-1",
      status: "SUCCEEDED",
      usageUsd: 0.01,
    }),
    getUsage: async () => 0.01,
    getOutput: async () => output,
    abort: async (runId) => {
      state.aborted.push(runId);
      state.lifecycle.push("abort");
    },
    cleanup: async (runId) => {
      state.cleaned.push(runId);
      state.lifecycle.push("cleanup");
    },
    ...overrides,
  };
  return { provider, state };
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
    const { repo, state: repositoryState } = repositoryFake();
    const { provider: apify, state: providerState } = providerFake();
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
    expect(repositoryState).toMatchObject({
      attachedRun: "run-1",
      completed: true,
    });
    expect(providerState).toMatchObject({
      started: true,
      cleaned: ["run-1"],
    });
  });

  it("aborts an attached run before cleanup when provider wait is ambiguous", async () => {
    const { repo, state: repositoryState } = repositoryFake();
    const { provider: apify, state: providerState } = providerFake({
      waitForFinish: async () => {
        throw new Error("provider_transport");
      },
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

    expect(providerState.lifecycle).toEqual(["start", "abort", "cleanup"]);
    expect(repositoryState.terminal?.status).toBe("failed");
    expect(repositoryState.storageCleaned).toBe(true);
  });

  it("stops before provider start when the daily budget is exhausted", async () => {
    const { repo, state: repositoryState } = repositoryFake({
      reserveDailyBudget: async () => "exhausted",
    });
    const { provider: apify, state: providerState } = providerFake();
    await processBrowserObservationJob(
      {
        observation_id: observation.id,
        operation_id: observation.operationId,
        attempt_no: 1,
      },
      { repository: repo, provider: apify, config },
    );
    expect(providerState.started).toBe(false);
    expect(repositoryState.terminal).toEqual({
      status: "budget_skipped",
      reason: "daily_budget_exhausted",
      usageUsd: 0,
    });
  });

  it("rejects output from an unexpected Actor build", async () => {
    const { repo, state: repositoryState } = repositoryFake();
    const { provider: apify } = providerFake({
      getOutput: async () => ({
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
    expect(repositoryState.completed).toBe(false);
    expect(repositoryState.terminal).toEqual({
      status: "failed",
      reason: "actor_build_mismatch",
      usageUsd: 0.01,
    });
  });

  it("does not create a duplicate paid run when stale state is unknown", async () => {
    const { repo, state: repositoryState } = repositoryFake({
      claim: async () => ({
        state: "claimed",
        observation: {
          ...observation,
          startedAt: new Date("2020-01-01T00:00:00.000Z"),
          resuming: true,
        },
      }),
    });
    const { provider: apify, state: providerState } = providerFake();
    await processBrowserObservationJob(
      {
        observation_id: observation.id,
        operation_id: observation.operationId,
        attempt_no: 1,
      },
      { repository: repo, provider: apify, config },
    );
    expect(providerState.started).toBe(false);
    expect(repositoryState.terminal).toEqual({
      status: "failed",
      reason: "unknown_run_state",
    });
  });

  it("keeps a recent missing run reconcileable across transient list lag", async () => {
    const current = new Date("2026-07-13T00:05:00.000Z");
    const { repo, state: repositoryState } = repositoryFake({
      claim: async () => ({
        state: "claimed",
        observation: {
          ...observation,
          startedAt: new Date("2026-07-13T00:00:00.000Z"),
          resuming: true,
        },
      }),
    });
    const { provider: apify, state: providerState } = providerFake();
    await processBrowserObservationJob(
      {
        observation_id: observation.id,
        operation_id: observation.operationId,
        attempt_no: 1,
      },
      { repository: repo, provider: apify, config, now: () => current },
    );
    expect(providerState.started).toBe(false);
    expect(repositoryState.terminal).toBeUndefined();
  });

  it("keeps a recent reconciliation provider error retryable", async () => {
    const current = new Date("2026-07-13T00:05:00.000Z");
    const { repo, state: repositoryState } = repositoryFake({
      claim: async () => ({
        state: "claimed",
        observation: {
          ...observation,
          startedAt: new Date("2026-07-13T00:00:00.000Z"),
          resuming: true,
        },
      }),
    });
    const { provider: apify, state: providerState } = providerFake({
      findRecentRun: async () => {
        throw new Error("provider_503");
      },
    });
    await processBrowserObservationJob(
      {
        observation_id: observation.id,
        operation_id: observation.operationId,
        attempt_no: 1,
      },
      { repository: repo, provider: apify, config, now: () => current },
    );
    expect(providerState.started).toBe(false);
    expect(repositoryState.terminal).toBeUndefined();
  });

  it("keeps an ambiguous provider start reconcileable", async () => {
    const { repo, state: repositoryState } = repositoryFake();
    const { provider: apify, state: providerState } = providerFake({
      start: async () => {
        throw new Error("transport_reset");
      },
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
    expect(repositoryState.reservations).toBe(1);
    expect(repositoryState.terminal).toBeUndefined();
    expect(providerState.cleaned).toEqual([]);
  });

  it("aborts and cleans a run that loses the attach fence", async () => {
    const { repo, state: repositoryState } = repositoryFake({
      attachRun: async () => "fenced",
    });
    const { provider: apify, state: providerState } = providerFake();
    await processBrowserObservationJob(
      {
        observation_id: observation.id,
        operation_id: observation.operationId,
        attempt_no: 1,
      },
      { repository: repo, provider: apify, config },
    );
    expect(providerState).toMatchObject({
      aborted: ["run-1"],
      cleaned: ["run-1"],
    });
    expect(repositoryState.storageCleaned).toBe(false);
  });

  it("does not disrupt a run already attached by the current lease owner", async () => {
    const { repo } = repositoryFake({
      attachRun: async () => "owned_elsewhere",
    });
    const { provider: apify, state: providerState } = providerFake();
    await processBrowserObservationJob(
      {
        observation_id: observation.id,
        operation_id: observation.operationId,
        attempt_no: 1,
      },
      { repository: repo, provider: apify, config },
    );
    expect(providerState).toMatchObject({ aborted: [], cleaned: [] });
  });

  it("reconciles provider usage for a failed paid run", async () => {
    const { repo, state: repositoryState } = repositoryFake();
    const { provider: apify } = providerFake({
      waitForFinish: async () => ({
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
    expect(repositoryState.terminal).toEqual({
      status: "failed",
      reason: "apify_timed_out",
      usageUsd: 0.037,
    });
  });
});
