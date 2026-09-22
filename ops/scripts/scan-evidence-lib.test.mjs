import assert from "node:assert/strict";
import test from "node:test";

import { analyzeAcceptedResponses, percentile, pollAcceptedScans } from "./scan-evidence-lib.mjs";

test("percentile uses the nearest-rank definition", () => {
  assert.equal(percentile([10, 20, 30, 40, 50], 0.95), 50);
  assert.equal(percentile([50, 10, 30, 20, 40], 0.5), 30);
  assert.equal(percentile([], 0.95), Number.POSITIVE_INFINITY);
});

test("accepted response analysis detects malformed and duplicate capabilities", () => {
  const valid = {
    status: 202,
    apiMs: 10,
    scanId: "scan-a",
    accessToken: "a".repeat(32),
    statusUrl: "/api/v1/scans/scan-a/status",
    acceptedAtMs: 10,
  };
  const result = analyzeAcceptedResponses([
    valid,
    { ...valid, scanId: "scan-a", apiMs: 20 },
    { ...valid, scanId: undefined, apiMs: 30 },
    { status: 429, apiMs: 40 },
  ]);
  assert.equal(result.acceptedResponses, 3);
  assert.equal(result.accepted.length, 2);
  assert.equal(result.malformedAccepted, 1);
  assert.equal(result.duplicateIds, 1);
  assert.equal(result.apiP95Ms, 30);
});

test("poller records first running and terminal timing for every capability", async () => {
  let currentTime = 0;
  const statuses = new Map([
    ["scan-a", ["running", "completed"]],
    ["scan-b", ["running", "partial"]],
  ]);
  const scans = [...statuses.keys()].map((scanId) => ({
    scanId,
    acceptedAtMs: 0,
  }));
  const polled = await pollAcceptedScans(scans, {
    intervalMs: 100,
    timeoutMs: 2_000,
    now: () => currentTime,
    sleep: async (milliseconds) => {
      currentTime += milliseconds;
      await Promise.resolve();
    },
    fetchStatus: async ({ scanId }) => ({
      status: statuses.get(scanId).shift(),
      progress: { completed: 18, total: 18 },
      checks: [],
    }),
  });

  assert.equal(polled.results.length, 2);
  assert.ok(polled.results.every((result) => result.outcome === "terminal"));
  assert.deepEqual(polled.results.map((result) => result.terminalStatus).sort(), [
    "completed",
    "partial",
  ]);
  assert.ok(polled.observedMaxRunning <= 2);
  assert.ok(polled.results.every((result) => result.terminalMs >= result.queueMs));
});

test("poller marks a capability lost after the bounded timeout", async () => {
  let currentTime = 0;
  const polled = await pollAcceptedScans([{ scanId: "scan-lost", acceptedAtMs: 0 }], {
    intervalMs: 100,
    timeoutMs: 250,
    now: () => currentTime,
    sleep: async (milliseconds) => {
      currentTime += milliseconds;
    },
    fetchStatus: async () => ({ status: "queued" }),
  });
  assert.equal(polled.results[0].outcome, "timeout");
  assert.equal(polled.results[0].lastStatus, "queued");
});
