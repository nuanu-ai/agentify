/**
 * The scan queue the process starts once and shares: the callers that ask
 * while a start runs share it, a started queue is kept, and a start that
 * failed is not, so a scan asked for once the database answers again starts
 * the queue afresh rather than failing until the process restarts.
 */

import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { type FakePostgres, fakePostgres } from "../../testing/fake-postgres";
import { getScanQueue, stopScanQueue } from "./queue";

let database: FakePostgres;

/** The statement that makes the scan queue, the last step of a start. */
const MAKING_THE_QUEUE = /create_queue\('scan-v1'/;

beforeAll(async () => {
  // pg-boss starts only where its schema is installed, which it asks first.
  database = await fakePostgres([[/to_regclass/, { name: "pgboss.version" }]]);
  vi.stubEnv("DATABASE_URL", database.url);
});

afterEach(async () => {
  database.refusing = undefined;
  await stopScanQueue().catch(() => undefined);
});

afterAll(async () => {
  await database.close();
  vi.unstubAllEnvs();
});

it("shares one start among the callers that ask while it runs, and keeps the queue it started", async () => {
  const [first, second] = await Promise.all([getScanQueue(), getScanQueue()]);

  expect(second).toBe(first);
  expect(await getScanQueue()).toBe(first);
});

it("starts the queue afresh for the next caller after a start that failed", async () => {
  database.refusing = MAKING_THE_QUEUE;
  await expect(getScanQueue()).rejects.toThrow();

  database.refusing = undefined;
  const started = await getScanQueue();

  expect(await getScanQueue()).toBe(started);
});

it("leaves no connection to the database open after a start that failed", async () => {
  database.refusing = MAKING_THE_QUEUE;
  await expect(getScanQueue()).rejects.toThrow();

  for (let waited = 0; database.connections() > 0 && waited < 2_000; waited += 20) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  expect(database.connections()).toBe(0);
});
