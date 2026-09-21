import type { CheckResult, ScanJobV1 } from "@agentify/scanner-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ScanEvaluation } from "@agentify/scanner";
import {
  processScanJob,
  type ScanJobRepository,
  type TerminalCommit,
} from "./scan-job.js";
import type { ScanRunOptions } from "./scan-runner.js";

const job: ScanJobV1 = {
  scan_id: "018f3f56-2ec8-7b16-8f66-5b8f93f3251f",
  canonical_target_url: "https://example.com/",
  segment: "store",
  rubric_version: "gtm-v1.0.0",
  deadline_at: new Date(Date.now() + 55_000).toISOString(),
  attempt_no: 1,
};

const check: CheckResult = {
  id: 1,
  status: "pass",
  nominalWeight: 5,
  applicableWeight: 5,
  earnedWeight: 5,
  summaryCode: "ok",
  evidence: {},
  userImpactCode: "ok",
  durationMs: 1,
};
const evaluation: ScanEvaluation = {
  checks: [check],
  score: {
    rubricVersion: "gtm-v1.0.0",
    score: 100,
    coverage: 1,
    level: "ahead_of_market",
    terminalStatus: "completed",
    nominalWeight: 100,
    applicableWeight: 5,
    assessedWeight: 5,
    earnedWeight: 5,
  },
  fingerprint: {
    detectorVersion: "fingerprint-v1.0.0",
    platform: { value: "custom/unknown", confidence: "low", signals: [] },
    wafCdn: [],
    pspMarkers: [],
  },
  findings: { negativeCheckIds: [], positiveCheckId: 1 },
};

const repository = (
  claim: "claimed" | "terminal" | "in_progress" = "claimed",
) => {
  const state: {
    claimed: boolean;
    checks: Map<number, CheckResult>;
    terminal?: TerminalCommit;
    failure?: {
      code: string;
      retryable: boolean;
      at: Date;
    };
    heartbeatAt?: Date;
    leaseExpiresAt?: Date;
    fencedCheckId?: number;
  } = {
    claimed: false,
    checks: new Map(),
  };
  const repo: ScanJobRepository = {
    claim: async () => {
      state.claimed = true;
      return claim;
    },
    heartbeat: async (_scanId, _attemptNo, at) => {
      state.heartbeatAt = at;
      state.leaseExpiresAt = new Date(at.getTime() + 15_000);
    },
    upsertCheck: async (_scanId, _attemptNo, persisted) => {
      state.checks.set(persisted.id, persisted);
      return true;
    },
    findReusableSnapshot: async () => undefined,
    commitTerminal: async (input) => {
      if (!state.checks.has(check.id))
        throw new Error("terminal_commit_without_persisted_check");
      state.terminal = input;
      return "committed";
    },
    markSystemFailure: async (_scanId, _attemptNo, code, retryable, at) => {
      state.failure = { code, retryable, at };
    },
  };
  return { repo, state };
};

describe("scan job lifecycle", () => {
  afterEach(() => vi.useRealTimers());

  it("upserts checks before terminal commit and only resolves after commit", async () => {
    const { repo, state } = repository();
    const runner = { run: async () => ({ ...evaluation, requestCount: 12 }) };
    await expect(
      processScanJob(job, {
        repository: repo,
        runner: runner as never,
        cacheEnabled: false,
      }),
    ).resolves.toBe("committed");
    expect(state.checks.get(check.id)).toEqual(check);
    expect(state.terminal).toMatchObject({
      scanId: job.scan_id,
      evaluation,
    });
  });

  it("skips an immutable terminal scan on redelivery", async () => {
    const { repo, state } = repository("terminal");
    const runner = {
      run: async () => {
        throw new Error("terminal scan must not run again");
      },
    };
    await expect(
      processScanJob(job, {
        repository: repo,
        runner: runner as never,
        cacheEnabled: false,
      }),
    ).resolves.toBe("skipped");
    expect(state.claimed).toBe(true);
    expect(state.checks.size).toBe(0);
    expect(state.terminal).toBeUndefined();
  });

  it("uses a cache snapshot without reusing acquisition identity", async () => {
    const { repo, state } = repository();
    repo.findReusableSnapshot = async () => ({
      ...evaluation,
      sourceScanId: "source-scan",
      expiresAt: new Date(Date.now() + 1000),
    });
    const runner = {
      run: async () => {
        throw new Error("cache hit must not acquire the target again");
      },
    };
    await processScanJob(job, {
      repository: repo,
      runner: runner as never,
      cacheEnabled: true,
    });
    expect(state.terminal).toMatchObject({
      scanId: job.scan_id,
      cacheHit: true,
      sourceScanId: "source-scan",
    });
    expect(JSON.stringify(state.terminal)).not.toMatch(
      /lead|utm|token|session/i,
    );
  });

  it("marks retryable system failure on first attempt", async () => {
    const { repo, state } = repository();
    const runner = {
      run: async () => {
        throw new Error(
          "network sdk crashed with https://secret.example/?token=x",
        );
      },
    };
    await expect(
      processScanJob(job, {
        repository: repo,
        runner: runner as never,
        cacheEnabled: false,
      }),
    ).rejects.toThrow();
    expect(state.failure).toMatchObject({
      code: "scan_system_error",
      retryable: true,
      at: expect.any(Date),
    });
  });

  it("stops a stale attempt when a progressive check write is fenced", async () => {
    const { repo, state } = repository();
    repo.upsertCheck = async (_scanId, _attemptNo, rejected) => {
      state.fencedCheckId = rejected.id;
      return false;
    };
    const runner = {
      run: async (_job: ScanJobV1, options: ScanRunOptions) => {
        await options.onChecksComplete?.([check]);
        return { ...evaluation, requestCount: 1 };
      },
    };
    await expect(
      processScanJob(job, {
        repository: repo,
        runner: runner as never,
        cacheEnabled: false,
      }),
    ).resolves.toBe("skipped");
    expect(state.fencedCheckId).toBe(check.id);
    expect(state.terminal).toBeUndefined();
  });

  it("renews a long-running job lease and stops heartbeats after completion", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-21T12:00:00.000Z"));
    const { repo, state } = repository();
    let complete!: (value: ScanEvaluation) => void;
    const run = new Promise<ScanEvaluation>((resolve) => {
      complete = resolve;
    });

    const processing = processScanJob(job, {
      repository: repo,
      runner: { run: async () => await run } as never,
      cacheEnabled: false,
      now: () => new Date(Date.now()),
    });
    await vi.advanceTimersByTimeAsync(20_000);

    expect(state.heartbeatAt?.toISOString()).toBe("2026-09-21T12:00:20.000Z");
    expect(state.leaseExpiresAt?.toISOString()).toBe(
      "2026-09-21T12:00:35.000Z",
    );

    complete(evaluation);
    await expect(processing).resolves.toBe("committed");
    const terminalLease = state.leaseExpiresAt?.toISOString();
    await vi.advanceTimersByTimeAsync(30_000);

    expect(state.terminal).toBeDefined();
    expect(state.leaseExpiresAt?.toISOString()).toBe(terminalLease);
  });

  it("atomically requests a versioned browser row then best-effort enqueues it", async () => {
    const { repo, state } = repository();
    let queued: unknown;
    await processScanJob(job, {
      repository: repo,
      runner: { run: async () => evaluation } as never,
      cacheEnabled: false,
      browserObservation: {
        actorId: "owner/agentify-browser-observer",
        actorBuild: "1.0.42",
        sampleRate: 1,
        enqueue: async (input) => {
          queued = input;
        },
      },
    });
    expect(state.terminal?.browserObservation).toMatchObject({
      observationVersion: "browser-public-v1.0.0",
      actorId: "owner/agentify-browser-observer",
      actorBuild: "1.0.42",
    });
    expect(queued).toEqual({
      observation_id: state.terminal?.browserObservation?.id,
      operation_id: state.terminal?.browserObservation?.operationId,
      attempt_no: 1,
    });
  });

  it.each(["robots_disallowed", "robots_unavailable"])(
    "does not request a browser observation when base robots is %s",
    async (errorCode) => {
      const { repo, state } = repository();
      let queued = false;
      await processScanJob(job, {
        repository: repo,
        runner: {
          run: async () => ({
            ...evaluation,
            checks: [
              {
                ...check,
                status: "unavailable" as const,
                summaryCode: errorCode,
                userImpactCode: errorCode,
                earnedWeight: 0,
                errorCode,
              },
            ],
          }),
        } as never,
        cacheEnabled: false,
        browserObservation: {
          actorId: "owner/agentify-browser-observer",
          actorBuild: "1.0.42",
          sampleRate: 1,
          enqueue: async () => {
            queued = true;
          },
        },
      });

      expect(state.terminal?.browserObservation).toBeUndefined();
      expect(queued).toBe(false);
    },
  );
});
