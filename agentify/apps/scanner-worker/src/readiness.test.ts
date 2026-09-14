import { describe, expect, it, vi } from "vitest";

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
  it("recovers queue readiness after a transient pg-boss failure", async () => {
    const state = health();
    const writeHeartbeat = vi.fn().mockResolvedValue(undefined);

    await expect(
      refreshWorkerReadiness({
        health: state,
        probeDatabase: async () => true,
        probeQueue: async () => {
          throw new Error("transient queue failure with secret details");
        },
        writeHeartbeat,
        now: () => new Date("2026-07-17T00:00:00.000Z"),
      }),
    ).resolves.toMatchObject({ ready: false, queueConnected: false });
    expect(writeHeartbeat).toHaveBeenLastCalledWith({
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
        now: () => new Date("2026-07-17T00:00:10.000Z"),
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
      lastHeartbeatAt: "2026-07-17T00:00:10.000Z",
    });
  });

  it("does not publish a heartbeat when the database probe fails", async () => {
    const state = health();
    const writeHeartbeat = vi.fn();
    const onDatabaseError = vi.fn();
    await refreshWorkerReadiness({
      health: state,
      probeDatabase: async () => {
        throw new Error("database unavailable");
      },
      probeQueue: async () => true,
      writeHeartbeat,
      onDatabaseError,
    });
    expect(writeHeartbeat).not.toHaveBeenCalled();
    expect(onDatabaseError).toHaveBeenCalledOnce();
    expect(state.ready).toBe(false);
  });
});
