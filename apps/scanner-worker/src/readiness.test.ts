import { describe, expect, it } from "vitest";

import type { WorkerHealth } from "./health.js";
import { refreshWorkerReadiness } from "./readiness.js";

const health = (): WorkerHealth => ({
  live: true,
  ready: false,
  queueConnected: false,
  databaseConnected: false,
  configuredConcurrency: 4,
  lastHeartbeatAt: null,
});

describe("worker readiness refresh", () => {
  it("withdraws and recovers queue readiness after a transient pg-boss failure", async () => {
    const state = health();
    const heartbeats: unknown[] = [];
    const writeHeartbeat = async (heartbeat: unknown) => {
      heartbeats.push(heartbeat);
    };

    await expect(
      refreshWorkerReadiness({
        health: state,
        probeDatabase: async () => true,
        probeQueue: async () => true,
        writeHeartbeat,
        now: () => new Date("2026-07-17T00:00:00.000Z"),
      }),
    ).resolves.toEqual({
      ready: true,
      queueConnected: true,
      databaseConnected: true,
    });

    await expect(
      refreshWorkerReadiness({
        health: state,
        probeDatabase: async () => true,
        probeQueue: async () => {
          throw new Error("transient queue failure with secret details");
        },
        writeHeartbeat,
        now: () => new Date("2026-07-17T00:00:10.000Z"),
      }),
    ).resolves.toMatchObject({ ready: false, queueConnected: false });
    expect(heartbeats.at(-1)).toEqual({
      ready: false,
      queueConnected: false,
      databaseConnected: true,
    });

    await expect(
      refreshWorkerReadiness({
        health: state,
        probeDatabase: async () => true,
        probeQueue: async () => true,
        writeHeartbeat,
        now: () => new Date("2026-07-17T00:00:20.000Z"),
      }),
    ).resolves.toEqual({
      ready: true,
      queueConnected: true,
      databaseConnected: true,
    });
    expect(state).toMatchObject({
      ready: true,
      queueConnected: true,
      databaseConnected: true,
      lastHeartbeatAt: "2026-07-17T00:00:20.000Z",
    });
  });

  it("does not publish a heartbeat when the database probe fails", async () => {
    const state = health();
    const events = { heartbeatPublished: false, databaseError: false };
    await refreshWorkerReadiness({
      health: state,
      probeDatabase: async () => {
        throw new Error("database unavailable");
      },
      probeQueue: async () => true,
      writeHeartbeat: async () => {
        events.heartbeatPublished = true;
      },
      onDatabaseError: () => {
        events.databaseError = true;
      },
    });
    expect(events).toEqual({
      heartbeatPublished: false,
      databaseError: true,
    });
    expect(state.ready).toBe(false);
  });

  it("withdraws readiness when persisting the heartbeat fails", async () => {
    const state = health();
    const events = { databaseError: false };

    await expect(
      refreshWorkerReadiness({
        health: state,
        probeDatabase: async () => true,
        probeQueue: async () => true,
        writeHeartbeat: async () => {
          throw new Error("heartbeat storage unavailable");
        },
        onDatabaseError: () => {
          events.databaseError = true;
        },
      }),
    ).resolves.toEqual({
      ready: false,
      queueConnected: true,
      databaseConnected: false,
    });
    expect(state).toMatchObject({
      ready: false,
      queueConnected: true,
      databaseConnected: false,
      lastHeartbeatAt: null,
    });
    expect(events.databaseError).toBe(true);
  });

  it("uses the production clock after a successful heartbeat", async () => {
    const state = health();
    const before = Date.now();

    await expect(
      refreshWorkerReadiness({
        health: state,
        probeDatabase: async () => true,
        probeQueue: async () => true,
        writeHeartbeat: async () => undefined,
      }),
    ).resolves.toEqual({
      ready: true,
      queueConnected: true,
      databaseConnected: true,
    });

    const heartbeatAt = Date.parse(state.lastHeartbeatAt ?? "");
    expect(heartbeatAt).toBeGreaterThanOrEqual(before);
    expect(heartbeatAt).toBeLessThanOrEqual(Date.now());
    expect(state.ready).toBe(true);
  });
});
