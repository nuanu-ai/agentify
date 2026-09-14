import type { CheckResult, ScanJobV1 } from "@b2a/contracts";
import { describe, expect, it, vi } from "vitest";
import type { ScanEvaluation } from "@b2a/scanner-core";
import { processScanJob, type ScanJobRepository } from "./scan-job.js";
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
  const calls: string[] = [];
  const repo: ScanJobRepository = {
    claim: async () => {
      calls.push("claim");
      return claim;
    },
    heartbeat: async () => {
      calls.push("heartbeat");
    },
    upsertCheck: async () => {
      calls.push("upsert");
      return true;
    },
    findReusableSnapshot: async () => undefined,
    commitTerminal: async () => {
      calls.push("commit");
      return "committed";
    },
    markSystemFailure: async () => {
      calls.push("failure");
    },
  };
  return { repo, calls };
};

describe("scan job lifecycle", () => {
  it("upserts checks before terminal commit and only resolves after commit", async () => {
    const { repo, calls } = repository();
    const runner = {
      run: vi.fn(async () => ({ ...evaluation, requestCount: 12 })),
    };
    await expect(
      processScanJob(job, {
        repository: repo,
        runner: runner as never,
        cacheEnabled: false,
      }),
    ).resolves.toBe("committed");
    expect(calls).toEqual(["claim", "upsert", "commit"]);
    expect(runner.run).toHaveBeenCalledOnce();
  });

  it("skips an immutable terminal scan on redelivery", async () => {
    const { repo, calls } = repository("terminal");
    const runner = { run: vi.fn() };
    await expect(
      processScanJob(job, {
        repository: repo,
        runner: runner as never,
        cacheEnabled: false,
      }),
    ).resolves.toBe("skipped");
    expect(calls).toEqual(["claim"]);
    expect(runner.run).not.toHaveBeenCalled();
  });

  it("uses a cache snapshot without reusing acquisition identity", async () => {
    const { repo } = repository();
    repo.findReusableSnapshot = async () => ({
      ...evaluation,
      sourceScanId: "source-scan",
      expiresAt: new Date(Date.now() + 1000),
    });
    const commits: unknown[] = [];
    repo.commitTerminal = async (input) => {
      commits.push(input);
      return "committed";
    };
    const runner = { run: vi.fn() };
    await processScanJob(job, {
      repository: repo,
      runner: runner as never,
      cacheEnabled: true,
    });
    expect(runner.run).not.toHaveBeenCalled();
    expect(commits[0]).toMatchObject({
      scanId: job.scan_id,
      cacheHit: true,
      sourceScanId: "source-scan",
    });
    expect(JSON.stringify(commits[0])).not.toMatch(/lead|utm|token|session/i);
  });

  it("marks retryable system failure on first attempt", async () => {
    const { repo } = repository();
    const failures: unknown[] = [];
    repo.markSystemFailure = async (...args) => {
      failures.push(args);
    };
    const runner = {
      run: vi.fn(async () => {
        throw new Error(
          "network sdk crashed with https://secret.example/?token=x",
        );
      }),
    };
    await expect(
      processScanJob(job, {
        repository: repo,
        runner: runner as never,
        cacheEnabled: false,
      }),
    ).rejects.toThrow();
    expect(failures[0]).toEqual([
      job.scan_id,
      1,
      "scan_system_error",
      true,
      expect.any(Date),
    ]);
  });

  it("stops a stale attempt when a progressive check write is fenced", async () => {
    const { repo, calls } = repository();
    repo.upsertCheck = async () => {
      calls.push("fenced-upsert");
      return false;
    };
    const runner = {
      run: vi.fn(async (_job: ScanJobV1, options: ScanRunOptions) => {
        await options.onChecksComplete?.([check]);
        return { ...evaluation, requestCount: 1 };
      }),
    };
    await expect(
      processScanJob(job, {
        repository: repo,
        runner: runner as never,
        cacheEnabled: false,
      }),
    ).resolves.toBe("skipped");
    expect(calls).toEqual(["claim", "fenced-upsert"]);
    expect(calls).not.toContain("commit");
  });

  it("atomically requests a versioned browser row then best-effort enqueues it", async () => {
    const { repo } = repository();
    const commits: Parameters<ScanJobRepository["commitTerminal"]>[0][] = [];
    repo.commitTerminal = async (input) => {
      commits.push(input);
      return "committed";
    };
    const enqueue = vi.fn().mockResolvedValue(undefined);
    await processScanJob(job, {
      repository: repo,
      runner: { run: vi.fn(async () => evaluation) } as never,
      cacheEnabled: false,
      browserObservation: {
        actorId: "owner/agentify-browser-observer",
        actorBuild: "1.0.42",
        sampleRate: 1,
        enqueue,
      },
    });
    expect(commits[0]?.browserObservation).toMatchObject({
      observationVersion: "browser-public-v1.0.0",
      actorId: "owner/agentify-browser-observer",
      actorBuild: "1.0.42",
    });
    expect(enqueue).toHaveBeenCalledWith({
      observation_id: commits[0]?.browserObservation?.id,
      operation_id: commits[0]?.browserObservation?.operationId,
      attempt_no: 1,
    });
  });

  it.each(["robots_disallowed", "robots_unavailable"])(
    "does not request a browser observation when base robots is %s",
    async (errorCode) => {
      const { repo } = repository();
      const commits: Parameters<ScanJobRepository["commitTerminal"]>[0][] = [];
      repo.commitTerminal = async (input) => {
        commits.push(input);
        return "committed";
      };
      const enqueue = vi.fn().mockResolvedValue(undefined);
      await processScanJob(job, {
        repository: repo,
        runner: {
          run: vi.fn(async () => ({
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
          })),
        } as never,
        cacheEnabled: false,
        browserObservation: {
          actorId: "owner/agentify-browser-observer",
          actorBuild: "1.0.42",
          sampleRate: 1,
          enqueue,
        },
      });

      expect(commits[0]?.browserObservation).toBeUndefined();
      expect(enqueue).not.toHaveBeenCalled();
    },
  );
});
