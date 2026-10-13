/**
 * The database ending one of the worker's connections, from its side, while a
 * transaction holds it. The worker goes on, says its database is down until
 * readiness reaches it again, and logs one line naming the failure by its
 * kind, never by its words or the connection's settings. An `error` event
 * nobody listens to would instead end the process, with every scan it runs.
 * What hears a held connection stops hearing it once it is given back, or a
 * connection checked out over and over would gather listeners without end.
 */

import { createLogger } from "@agentify/observability";
import { type FakePostgres, fakePostgres } from "@agentify/scanner-database/fake-postgres";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { WorkerHealth } from "./health.js";
import { workerDatabase } from "./infrastructure.js";

let database: FakePostgres;

const healthy = (): WorkerHealth => ({
  live: true,
  ready: true,
  queueConnected: true,
  databaseConnected: true,
  configuredConcurrency: 1,
  lastHeartbeatAt: null,
});

beforeAll(async () => {
  database = await fakePostgres();
});

afterAll(async () => {
  await database.close();
});

it("logs a connection the database ends while a transaction holds it once, by its kind alone, and goes on", async () => {
  const logged: string[] = [];
  const unlistened: string[] = [];
  const health = healthy();
  const { pool } = workerDatabase(
    database.url,
    health,
    createLogger({
      service: "scanner-worker",
      environment: "test",
      sink: (line) => logged.push(line),
    }),
  );
  const collect = (thrown: unknown) => {
    unlistened.push(String(thrown));
  };
  process.on("uncaughtException", collect);
  process.on("unhandledRejection", collect);
  try {
    const held = await pool.connect();
    await held.query("begin");

    database.drop();
    for (let waited = 0; logged.length + unlistened.length === 0 && waited < 5_000; waited += 10) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    // The end that follows the fatal error has arrived by now.
    await new Promise((resolve) => setTimeout(resolve, 100));
    held.release(true);
  } finally {
    process.removeListener("uncaughtException", collect);
    process.removeListener("unhandledRejection", collect);
    await pool.end();
  }

  expect(unlistened).toEqual([]);
  expect(health.databaseConnected).toBe(false);
  expect(logged.map((line) => JSON.parse(line))).toEqual([
    expect.objectContaining({
      level: "error",
      event: "worker_database_error",
      error_type: expect.any(String),
    }),
  ]);
  const text = logged.join("\n");
  expect(text).not.toContain(database.user);
  expect(text).not.toContain(database.database);
  expect(text).not.toMatch(new RegExp(`\\b${database.port}\\b`));
  expect(text).not.toMatch(/terminat|administrator/i);
});

it("gathers no listeners on a connection checked out and given back over and over", async () => {
  const warned: string[] = [];
  const notice = (warning: Error) => {
    warned.push(warning.name);
  };
  process.on("warning", notice);
  const { pool } = workerDatabase(
    database.url,
    healthy(),
    createLogger({ service: "scanner-worker", environment: "test", sink: () => {} }),
  );
  try {
    for (let round = 0; round < 20; round += 1) {
      const held = await pool.connect();
      held.release();
    }
    // A warning is emitted on the tick after the listener that raised it.
    await new Promise((resolve) => setTimeout(resolve, 20));
  } finally {
    process.removeListener("warning", notice);
    await pool.end();
  }

  expect(pool.totalCount).toBe(0);
  expect(warned).not.toContain("MaxListenersExceededWarning");
});
