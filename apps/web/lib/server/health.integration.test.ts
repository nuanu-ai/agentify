/**
 * The readiness probe against a real database of its own: how many readings
 * of the scanner's signals the checks that arrive together cost, which
 * readings later checks are answered from, and what a check is told when a
 * reading never finishes.
 */

import { fileURLToPath } from "node:url";
import { CONSENT_POLICY_VERSION } from "@agentify/analytics";
import { createDatabase, migrateDatabase } from "@agentify/scanner-database";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { loader as healthRoute } from "../../app/routes/api/health";
import { action as consentRoute } from "../../app/routes/api/v1/consent";
import { getDatabase } from "./database";

const connectionString = process.env.MIGRATION_TEST_DATABASE_URL;
if (!connectionString?.includes("_migration_test")) {
  throw new Error(
    "The readiness probe's integration requires a dedicated *_migration_test database",
  );
}
process.env.DATABASE_URL = connectionString;
process.env.APP_BASE_URL = "http://localhost:3000";
process.env.TOKEN_HMAC_SECRET = "health-integration-hmac-secret-with-32-bytes";
process.env.EMAIL_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString("base64");
process.env.TURNSTILE_ENFORCED = "false";
process.env.REGISTRATION_ENABLED = "false";

const migrationsFolder = fileURLToPath(
  new URL("../../../../packages/scanner-database/migrations", import.meta.url),
);
/** A connection of the test's own, outside the pool the scanner serves from. */
const outside = createDatabase(connectionString, { max: 2 });

const RESET =
  "drop schema if exists public cascade; drop schema if exists drizzle cascade; create schema public";

beforeAll(async () => {
  await outside.pool.query(RESET);
  await migrateDatabase(outside.db, migrationsFolder);
});

afterAll(async () => {
  await getDatabase().pool.end();
  await outside.pool.query(RESET);
  await outside.pool.end();
});

type Answer = Readonly<{
  status: number;
  body: { status: string; timestamp: string; dependencies: Record<string, string> };
}>;

const check = async (): Promise<Answer> => {
  const response = await healthRoute({
    request: new Request("http://localhost:3000/api/health"),
    params: {},
  });
  return { status: response.status, body: await response.json() };
};

/** A worker that says it is ready, as the scanner worker writes it. */
const workerReady = () =>
  outside.pool.query(
    `insert into worker_heartbeats (worker_id, service, started_at, heartbeat_at, metadata)
     values ('health-test', 'scanner-worker', now(), now(),
       '{"ready": true, "queue_connected": true, "database_connected": true}')
     on conflict (worker_id) do update set heartbeat_at = now()`,
  );
const workerGone = () => outside.pool.query("delete from worker_heartbeats");

/** How many readings of the signals are waiting on the outbox this test holds. */
const readingsWaiting = async () =>
  (
    await outside.pool.query<{ count: string }>(
      `select count(*)::text as count from pg_stat_activity
        where datname = current_database() and wait_event_type = 'Lock'
          and query like '%delivery_outbox%'`,
    )
  ).rows[0]?.count;

/**
 * Runs `whileHeld` with the outbox locked, so every reading of the signals,
 * which reads the outbox, stays in flight until the lock is let go.
 */
const withOutboxHeld = async (whileHeld: (release: () => Promise<void>) => Promise<void>) => {
  const locker = await outside.pool.connect();
  let held = true;
  const release = async () => {
    if (!held) return;
    held = false;
    await locker.query("rollback");
  };
  try {
    await locker.query("begin; lock table delivery_outbox in access exclusive mode");
    await whileHeld(release);
  } finally {
    await release();
    locker.release();
  }
};

const within = <T>(promise: Promise<T>, ms: number): Promise<T | "not answered"> =>
  Promise.race([
    promise,
    new Promise<"not answered">((resolve) => setTimeout(() => resolve("not answered"), ms)),
  ]);

/** Room for a loaded machine, where the database and the timers are slow. */
const LOADED = { timeout: 5_000, interval: 100 };

/** Waits out any ready reading kept from before, so the next ready one is read afresh. */
const untilNotReady = async () => {
  await workerGone();
  await vi.waitFor(async () => expect((await check()).status).not.toBe(200), {
    timeout: 8_000,
    interval: 250,
  });
};

describe("the readiness probe", () => {
  it("answers within the outside probe's limit that the database's state is unknown while a lock holds its reading, and never holds more than one connection for it", async () => {
    await withOutboxHeld(async () => {
      const startedAt = Date.now();
      const first = await within(check(), 7_000);
      expect(Date.now() - startedAt).toBeLessThan(5_500);
      expect(first).toMatchObject({
        status: 503,
        body: { status: "unavailable", dependencies: { database: "unknown" } },
      });
      // The server gave up the reading by itself, and its connection with it.
      await vi.waitFor(async () => expect(await readingsWaiting()).toBe("0"), LOADED);

      const waiting: string[] = [];
      for (const pollUntil = Date.now() + 8_000; Date.now() < pollUntil; ) {
        const polled = check();
        await new Promise((resolve) => setTimeout(resolve, 250));
        waiting.push((await readingsWaiting()) ?? "");
        expect((await within(polled, 5_500)) as Answer).toMatchObject({ status: 503 });
      }
      expect(waiting.filter((count) => count !== "0" && count !== "1")).toEqual([]);
    });
  }, 25_000);

  it("starts no second reading while one it stopped waiting for still waits for a connection, and says the database's state is unknown at once", async () => {
    const { pool } = getDatabase();
    const taken = await Promise.all(
      Array.from({ length: pool.options.max ?? 10 }, () => pool.connect()),
    );
    try {
      expect(await within(check(), 7_000)).toMatchObject({
        body: { dependencies: { database: "unknown" } },
      });

      const startedAt = Date.now();
      const again = await check();
      expect(Date.now() - startedAt).toBeLessThan(1_000);
      expect(again).toMatchObject({ status: 503, body: { dependencies: { database: "unknown" } } });
      expect(pool.waitingCount).toBe(1);
    } finally {
      for (const client of taken) client.release();
    }
  }, 25_000);

  it("reads the operational signals once for many checks at the same moment, and leaves the pool to the visitors' requests", async () => {
    await untilNotReady();
    await withOutboxHeld(async (release) => {
      const checks = Array.from({ length: 20 }, check);
      await vi.waitFor(async () => expect(await readingsWaiting()).toBe("1"), LOADED);

      const choice = await within(
        consentRoute({
          request: new Request("http://localhost:3000/api/v1/consent", {
            method: "POST",
            headers: { origin: "http://localhost:3000", "content-type": "application/json" },
            body: JSON.stringify({
              policy_version: CONSENT_POLICY_VERSION,
              categories: {
                essential_processing: true,
                product_analytics: false,
                ads_measurement: false,
                marketing_email: false,
                dataset_reuse: false,
              },
            }),
          }),
          params: {},
        }).then((answered) => answered.status),
        5_000,
      );
      expect(choice).toBe(201);

      await release();
      const answers = await Promise.all(checks);
      expect(new Set(answers.map((answer) => JSON.stringify(answer))).size).toBe(1);
    });
  }, 25_000);

  it("reads afresh for the next check after a reading that is not ready", async () => {
    await untilNotReady();

    await workerReady();
    expect(await check()).toMatchObject({ status: 200, body: { status: "ok" } });
  }, 25_000);

  it("answers checks for a few seconds from a ready reading", async () => {
    await untilNotReady();
    await workerReady();
    const ready = await check();
    expect(ready.status).toBe(200);
    await workerGone();

    expect(await check()).toEqual(ready);
  }, 25_000);

  it("leaves no line saying a reading ran out of time once the reading has answered", async () => {
    await untilNotReady();
    await workerReady();
    const lines: string[] = [];
    vi.spyOn(console, "error").mockImplementation((line: unknown) => {
      lines.push(String(line));
    });
    try {
      expect((await check()).status).toBe(200);
      await new Promise((resolve) => setTimeout(resolve, 6_000));

      expect(lines.filter((line) => line.includes("health_check_failed"))).toEqual([]);
    } finally {
      vi.restoreAllMocks();
    }
  }, 25_000);
});
