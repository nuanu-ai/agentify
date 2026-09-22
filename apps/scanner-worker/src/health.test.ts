import { afterEach, describe, expect, it } from "vitest";

import { startHealthServer, type WorkerHealth } from "./health.js";

const servers: ReturnType<typeof startHealthServer>[] = [];

afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});

describe("worker health server", () => {
  it("separates liveness from dependency readiness", async () => {
    const health: WorkerHealth = {
      live: true,
      ready: false,
      queueConnected: false,
      databaseConnected: false,
      configuredConcurrency: 10,
      lastHeartbeatAt: null,
    };
    const server = startHealthServer(0, health);
    servers.push(server);
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP server address");

    expect((await fetch(`http://127.0.0.1:${address.port}/health/live`)).status).toBe(200);
    const readiness = await fetch(`http://127.0.0.1:${address.port}/health/ready`);
    expect(readiness.status).toBe(503);
    expect(await readiness.json()).toMatchObject({
      checks: { configured_concurrency: 10 },
    });
  });
});
