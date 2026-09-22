import { describe, expect, it } from "vitest";

import {
  evaluateOperationalSignals,
  evaluateWorkerHeartbeat,
  READINESS_OUTBOX_DESTINATIONS,
} from "./worker-health";

describe("public worker dependency health", () => {
  const now = new Date("2026-07-17T00:00:30.000Z");

  it("requires fresh heartbeat and explicit queue/database readiness", () => {
    expect(
      evaluateWorkerHeartbeat(
        {
          heartbeat_at: "2026-07-17T00:00:20.000Z",
          metadata: {
            ready: true,
            queue_connected: true,
            database_connected: true,
          },
        },
        now,
      ),
    ).toMatchObject({ ready: true });

    expect(
      evaluateWorkerHeartbeat(
        {
          heartbeat_at: "2026-07-17T00:00:20.000Z",
          metadata: {
            ready: false,
            queue_connected: false,
            database_connected: true,
          },
        },
        now,
      ),
    ).toMatchObject({ ready: false, queueConnected: false });
  });

  it("does not mistake a stale or legacy heartbeat for readiness", () => {
    expect(
      evaluateWorkerHeartbeat(
        {
          heartbeat_at: "2026-07-16T23:59:00.000Z",
          metadata: { queue: "pg-boss" },
        },
        now,
      ),
    ).toEqual({
      ready: false,
      heartbeatFresh: false,
      queueConnected: false,
      databaseConnected: false,
    });
  });
});

describe("operational health thresholds", () => {
  const healthy = {
    queue_age_seconds: 0,
    stale_running: 0,
    accepted_15m: 20,
    failed_15m: 1,
    outbox_age_seconds: 0,
    outbox_dead_letters: 0,
  };

  it("degrades on queue lag, systemic failure, stale scans or outbox backlog", () => {
    expect(evaluateOperationalSignals(healthy)).toEqual({
      scannerCapacity: true,
      analyticsOutbox: true,
    });
    expect(evaluateOperationalSignals({ ...healthy, queue_age_seconds: 11 })).toMatchObject({
      scannerCapacity: false,
    });
    expect(evaluateOperationalSignals({ ...healthy, stale_running: 1 })).toMatchObject({
      scannerCapacity: false,
    });
    expect(evaluateOperationalSignals({ ...healthy, failed_15m: 2 })).toMatchObject({
      scannerCapacity: false,
    });
    expect(evaluateOperationalSignals({ ...healthy, outbox_age_seconds: 301 })).toMatchObject({
      analyticsOutbox: false,
    });
    expect(evaluateOperationalSignals({ ...healthy, outbox_dead_letters: 1 })).toMatchObject({
      analyticsOutbox: false,
    });
  });

  it("does not call one low-volume target failure systemic", () => {
    expect(
      evaluateOperationalSignals({
        ...healthy,
        accepted_15m: 1,
        failed_15m: 1,
      }),
    ).toMatchObject({ scannerCapacity: true });
  });

  it("keeps partner delivery incidents out of product readiness", () => {
    expect(READINESS_OUTBOX_DESTINATIONS).toEqual(["posthog", "meta"]);
    expect(READINESS_OUTBOX_DESTINATIONS).not.toContain("partner_tracker");
  });
});
