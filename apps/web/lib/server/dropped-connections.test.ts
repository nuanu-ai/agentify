/**
 * The database closing the scanner's connections, from its side, while no
 * request waits on them. Each is one log line naming the failure by its kind,
 * never by its words or the connection's settings, and none reaches the
 * process as an exception nothing caught, which would end it.
 */

import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { type FakePostgres, fakePostgres } from "../../testing/fake-postgres";
import { getDatabase } from "./database";
import { getScanQueue, stopScanQueue } from "./queue";

let database: FakePostgres;

beforeAll(async () => {
  // pg-boss starts only where its schema is installed, which it asks first.
  database = await fakePostgres([[/to_regclass/, { name: "pgboss.version" }]]);
  vi.stubEnv("DATABASE_URL", database.url);
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await stopScanQueue();
  await getDatabase().pool.end();
  await database.close();
  vi.unstubAllEnvs();
});

/**
 * What the process logged, and what reached it as an exception or a rejection
 * nothing caught, while `work` ran and until either appeared. An `error` event
 * nobody listens to is thrown where it was emitted, which the runner reports
 * beside the results while the test itself stays green, so it is collected
 * here to assert on.
 */
async function afterADrop(
  work: () => Promise<void>,
): Promise<Readonly<{ logged: string[]; unlistened: string[] }>> {
  const logged: string[] = [];
  const unlistened: string[] = [];
  vi.spyOn(console, "error").mockImplementation((line: unknown) => {
    logged.push(String(line));
  });
  const collect = (thrown: unknown) => {
    unlistened.push(String(thrown));
  };
  process.on("uncaughtException", collect);
  process.on("unhandledRejection", collect);
  try {
    await work();
    for (let waited = 0; logged.length + unlistened.length === 0 && waited < 5_000; waited += 10) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    // Every connection the drop closed has said so by now.
    await new Promise((resolve) => setTimeout(resolve, 50));
  } finally {
    process.removeListener("uncaughtException", collect);
    process.removeListener("unhandledRejection", collect);
  }
  return { logged, unlistened };
}

/** The lines a drop left, which name the failure by its kind and nothing the connection carried. */
const namedByKindAlone = (logged: readonly string[]): unknown[] => {
  const text = logged.join("\n");
  expect(text).not.toContain(database.user);
  expect(text).not.toContain(database.database);
  expect(text).not.toMatch(new RegExp(`\\b${database.port}\\b`));
  expect(text).not.toMatch(/terminated/i);
  return logged.map((line) => JSON.parse(line));
};

const failure = (event: string) =>
  expect.objectContaining({ level: "error", event, error_type: expect.any(String) });

it("logs a pooled connection the database closes while it is idle once, by its kind alone, and the process goes on", async () => {
  const { pool } = getDatabase();
  await pool.query("select 1");

  const { logged, unlistened } = await afterADrop(async () => database.drop());

  expect(unlistened).toEqual([]);
  expect(namedByKindAlone(logged)).toEqual([failure("web_database_connection_failed")]);
});

it("logs a connection the database closes while a transaction holds it once, by its kind alone, and the process goes on", async () => {
  const { db } = getDatabase();
  let finished: Promise<unknown> = Promise.resolve();

  const { logged, unlistened } = await afterADrop(async () => {
    let held: () => void = () => {};
    const holding = new Promise<void>((resolve) => {
      held = resolve;
    });
    finished = db
      .transaction(async (tx) => {
        await tx.execute(sql`select 1`);
        held();
        await new Promise((resolve) => setTimeout(resolve, 200));
      })
      .catch(() => undefined);
    await holding;
    database.drop();
  });
  await finished;

  expect(unlistened).toEqual([]);
  expect(namedByKindAlone(logged)).toEqual([failure("web_database_connection_failed")]);
});

it("logs the scan queue losing its connections by the failure's kind alone, and the process goes on", async () => {
  await getScanQueue();

  const { logged, unlistened } = await afterADrop(async () => database.drop());

  expect(unlistened).toEqual([]);
  expect(namedByKindAlone(logged)).toContainEqual(failure("web_queue_failed"));
});
