import { fileURLToPath } from "node:url";

import { createDatabase, createUuidV7, migrateDatabase } from "@agentify/scanner-database";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  AnalyticsOutboxRepository,
  createDestinationDeliverer,
  type OutboxRow,
  runOutboxCycle,
} from "./analytics-outbox.js";

const connectionString = process.env.MIGRATION_TEST_DATABASE_URL;
if (!connectionString) throw new Error("MIGRATION_TEST_DATABASE_URL is required");
const databaseName = new URL(connectionString).pathname.slice(1);
if (!databaseName.endsWith("_migration_test")) {
  throw new Error("MIGRATION_TEST_DATABASE_URL must name a dedicated *_migration_test database");
}

const migrationsFolder = fileURLToPath(
  new URL("../../../packages/scanner-database/migrations", import.meta.url),
);
const { db, pool } = createDatabase(connectionString, { max: 6 });
const seededSessionIds: string[] = [];

async function seedOutbox(input: { attempts?: number } = {}): Promise<{
  id: string;
  eventId: string;
}> {
  const sessionId = createUuidV7();
  const consentId = createUuidV7();
  const analyticsId = createUuidV7();
  const eventId = createUuidV7();
  const outboxId = createUuidV7();
  seededSessionIds.push(sessionId);

  await pool.query("insert into sessions (id, anonymous_id_hash) values ($1, $2)", [
    sessionId,
    `outbox-integration-${sessionId}`,
  ]);
  await pool.query(
    `insert into consent_snapshots
       (id, session_id, policy_version, categories, source)
     values ($1, $2, 'consent-v1.0.0', $3, 'api')`,
    [
      consentId,
      sessionId,
      JSON.stringify({
        essential_processing: true,
        product_analytics: true,
        ads_measurement: true,
        marketing_email: false,
        dataset_reuse: false,
        card_signal: false,
      }),
    ],
  );
  await pool.query(
    `insert into analytics_events
       (id, event_id, name, occurred_at, session_id, segment,
        landing_variant, properties, consent_snapshot_id)
     values ($1, $2, 'scan_completed', now(), $3, 'store',
             'store-v1', '{}', $4)`,
    [analyticsId, eventId, sessionId, consentId],
  );
  await pool.query(
    `insert into delivery_outbox
       (id, event_id, destination, payload, attempts, next_attempt_at)
     values ($1, $2, 'posthog', $3, $4, now() - interval '1 second')`,
    [outboxId, eventId, JSON.stringify({ event: "scan_completed" }), input.attempts ?? 0],
  );
  return { id: outboxId, eventId };
}

async function storedOutbox(id: string): Promise<{
  status: string;
  attempts: number;
  next_attempt_at: Date;
  last_error_code: string | null;
  delivered_at: Date | null;
  payload: unknown;
}> {
  const result = await pool.query<{
    status: string;
    attempts: number;
    next_attempt_at: Date;
    last_error_code: string | null;
    delivered_at: Date | null;
    payload: unknown;
  }>(
    `select status, attempts, next_attempt_at, last_error_code,
            delivered_at, payload
       from delivery_outbox where id = $1`,
    [id],
  );
  const row = result.rows[0];
  if (!row) throw new Error("seeded outbox row disappeared");
  return row;
}

beforeAll(async () => {
  await migrateDatabase(db, migrationsFolder);
});

afterEach(async () => {
  for (const sessionId of seededSessionIds.splice(0)) {
    await pool.query(
      "delete from delivery_outbox where event_id in (select event_id from analytics_events where session_id = $1)",
      [sessionId],
    );
    await pool.query("delete from analytics_events where session_id = $1", [sessionId]);
    await pool.query("delete from consent_snapshots where session_id = $1", [sessionId]);
    await pool.query("delete from sessions where id = $1", [sessionId]);
  }
});

afterAll(async () => {
  await pool.end();
});

describe("analytics outbox PostgreSQL effects", () => {
  it("lets two consumers deliver one row only once", async () => {
    const seeded = await seedOutbox();
    const deliveredEventIds = new Set<string>();
    const deliver = async (row: OutboxRow) => {
      if (deliveredEventIds.has(row.event_id)) {
        throw new Error("duplicate external delivery");
      }
      deliveredEventIds.add(row.event_id);
      return { ok: true } as const;
    };

    const claimed = await Promise.all([
      runOutboxCycle({
        repository: new AnalyticsOutboxRepository(pool, ["posthog"]),
        deliver,
      }),
      runOutboxCycle({
        repository: new AnalyticsOutboxRepository(pool, ["posthog"]),
        deliver,
      }),
    ]);

    expect(claimed.reduce((sum, count) => sum + count, 0)).toBe(1);
    expect(deliveredEventIds).toEqual(new Set([seeded.eventId]));
    await expect(storedOutbox(seeded.id)).resolves.toMatchObject({
      status: "delivered",
      attempts: 1,
      last_error_code: null,
    });
    expect((await storedOutbox(seeded.id)).delivered_at).toBeInstanceOf(Date);
  });

  it("returns a retryable failure to pending with the bounded next attempt", async () => {
    const seeded = await seedOutbox();
    const now = new Date("2030-09-21T12:00:00.000Z");

    await runOutboxCycle({
      repository: new AnalyticsOutboxRepository(pool, ["posthog"]),
      deliver: async () => ({
        ok: false,
        code: "posthog_http_503",
        retryable: true,
      }),
      now: () => now,
    });

    const stored = await storedOutbox(seeded.id);
    expect(stored).toMatchObject({
      status: "pending",
      attempts: 1,
      last_error_code: "posthog_http_503",
    });
    expect(stored.next_attempt_at.getTime() - now.getTime()).toBe(1_000);
  });

  it("moves the terminal retry attempt to dead-letter", async () => {
    const seeded = await seedOutbox({ attempts: 16 });

    await runOutboxCycle({
      repository: new AnalyticsOutboxRepository(pool, ["posthog"]),
      deliver: async () => ({
        ok: false,
        code: "posthog_http_503",
        retryable: true,
      }),
    });

    await expect(storedOutbox(seeded.id)).resolves.toMatchObject({
      status: "dead_letter",
      attempts: 17,
      last_error_code: "posthog_http_503",
    });
  });

  it("persists no provider response body", async () => {
    const responseBody = "provider secret diagnostic body";
    const seeded = await seedOutbox();
    const deliver = createDestinationDeliverer(
      {
        runtimeEnvironment: "test",
        posthog: {
          destinationEnvironment: "test",
          host: "https://test.posthog.invalid",
          enabled: true,
        },
      },
      async () => new Response(responseBody, { status: 400 }),
    );

    await runOutboxCycle({
      repository: new AnalyticsOutboxRepository(pool, ["posthog"]),
      deliver,
    });

    const stored = await storedOutbox(seeded.id);
    expect(stored).toMatchObject({
      status: "pending",
      attempts: 1,
      last_error_code: "posthog_http_400",
    });
    expect(JSON.stringify(stored)).not.toContain(responseBody);
  });
});
