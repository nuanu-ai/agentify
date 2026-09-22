import { fileURLToPath } from "node:url";

import {
  createDatabase,
  createUuidV7,
  migrateDatabase,
} from "@agentify/scanner-database";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  AnalyticsOutboxRepository,
  createDestinationDeliverer,
  createPartnerRateLimitedDeliverer,
  type OutboxRow,
  runOutboxCycle,
} from "./analytics-outbox.js";

const connectionString = process.env.MIGRATION_TEST_DATABASE_URL;
if (!connectionString)
  throw new Error("MIGRATION_TEST_DATABASE_URL is required");
const databaseName = new URL(connectionString).pathname.slice(1);
if (!databaseName.endsWith("_migration_test")) {
  throw new Error(
    "MIGRATION_TEST_DATABASE_URL must name a dedicated *_migration_test database",
  );
}

const migrationsFolder = fileURLToPath(
  new URL("../../../packages/scanner-database/migrations", import.meta.url),
);
const { db, pool } = createDatabase(connectionString, { max: 6 });
const seededSessionIds: string[] = [];

type Destination = "posthog" | "meta" | "partner_tracker";

async function seedOutbox(
  input: {
    destination?: Destination;
    payload?: unknown;
    attempts?: number;
    occurredAt?: Date;
  } = {},
): Promise<{ id: string; eventId: string }> {
  const sessionId = createUuidV7();
  const consentId = createUuidV7();
  const analyticsId = createUuidV7();
  const eventId = createUuidV7();
  const outboxId = createUuidV7();
  const occurredAt = input.occurredAt ?? new Date();
  const destination = input.destination ?? "posthog";
  const payload = input.payload ?? { event: "scan_completed" };
  seededSessionIds.push(sessionId);

  await pool.query(
    "insert into sessions (id, anonymous_id_hash) values ($1, $2)",
    [sessionId, `outbox-integration-${sessionId}`],
  );
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
     values ($1, $2, 'scan_completed', $3, $4, 'store',
             'store-v1', '{}', $5)`,
    [analyticsId, eventId, occurredAt, sessionId, consentId],
  );
  await pool.query(
    `insert into delivery_outbox
       (id, event_id, destination, payload, attempts, next_attempt_at)
     values ($1, $2, $3, $4, $5, now() - interval '1 second')`,
    [
      outboxId,
      eventId,
      destination,
      JSON.stringify(payload),
      input.attempts ?? 0,
    ],
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
    await pool.query("delete from analytics_events where session_id = $1", [
      sessionId,
    ]);
    await pool.query("delete from consent_snapshots where session_id = $1", [
      sessionId,
    ]);
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

  it("uses the partner retry schedule instead of the generic backoff", async () => {
    const occurredAt = new Date("2030-09-21T12:00:00.000Z");
    const seeded = await seedOutbox({
      destination: "partner_tracker",
      payload: { clickid: "Xk8sJ2QpR4vN7bL0aZ9wQg", event: "reg" },
      occurredAt,
    });

    await runOutboxCycle({
      repository: new AnalyticsOutboxRepository(pool, ["partner_tracker"]),
      deliver: async () => ({
        ok: false,
        code: "partner_tracker_http_503",
        retryable: true,
      }),
      now: () => occurredAt,
    });

    const stored = await storedOutbox(seeded.id);
    expect(stored).toMatchObject({
      status: "pending",
      attempts: 1,
      last_error_code: "partner_tracker_http_503",
    });
    expect(stored.next_attempt_at.getTime() - occurredAt.getTime()).toBe(
      60_000,
    );
  });

  it("stops partner delivery at the 24-hour cutoff", async () => {
    const occurredAt = new Date("2030-09-20T12:00:00.000Z");
    const clickId = "Xk8sJ2QpR4vN7bL0aZ9wQg";
    const seeded = await seedOutbox({
      destination: "partner_tracker",
      payload: { clickid: clickId, event: "reg" },
      occurredAt,
    });
    const delivery = { attempted: false };

    await runOutboxCycle({
      repository: new AnalyticsOutboxRepository(pool, ["partner_tracker"]),
      deliver: async () => {
        delivery.attempted = true;
        return { ok: true };
      },
      now: () => new Date("2030-09-21T12:00:00.000Z"),
    });

    const stored = await storedOutbox(seeded.id);
    expect(delivery.attempted).toBe(false);
    expect(stored).toMatchObject({
      status: "dead_letter",
      attempts: 1,
      last_error_code: "partner_tracker_retry_window_exhausted",
      payload: { event: "reg" },
    });
    expect(JSON.stringify(stored)).not.toContain(clickId);
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

  it("persists neither a provider response body nor a partner click id", async () => {
    const clickId = "Xk8sJ2QpR4vN7bL0aZ9wQg";
    const responseBody = "provider secret diagnostic body";
    const seeded = await seedOutbox({
      destination: "partner_tracker",
      payload: { clickid: clickId, event: "reg" },
    });
    const deliver = createDestinationDeliverer(
      {
        runtimeEnvironment: "production",
        partner: {
          destinationEnvironment: "production",
          enabled: true,
          secret: "partner-secret-value",
        },
      },
      async () => new Response(responseBody, { status: 400 }),
    );

    await runOutboxCycle({
      repository: new AnalyticsOutboxRepository(pool, ["partner_tracker"]),
      deliver,
    });

    const stored = await storedOutbox(seeded.id);
    expect(stored).toMatchObject({
      status: "dead_letter",
      attempts: 1,
      last_error_code: "partner_tracker_http_400",
      payload: { event: "reg" },
    });
    expect(JSON.stringify(stored)).not.toContain(clickId);
    expect(JSON.stringify(stored)).not.toContain(responseBody);
  });

  it("scrubs the partner click id after successful delivery", async () => {
    const clickId = "Xk8sJ2QpR4vN7bL0aZ9wQg";
    const seeded = await seedOutbox({
      destination: "partner_tracker",
      payload: { clickid: clickId, event: "reg" },
    });

    await runOutboxCycle({
      repository: new AnalyticsOutboxRepository(pool, ["partner_tracker"]),
      deliver: async () => ({ ok: true }),
    });

    const stored = await storedOutbox(seeded.id);
    expect(stored).toMatchObject({
      status: "delivered",
      attempts: 1,
      last_error_code: null,
      payload: { event: "reg" },
    });
    expect(stored.delivered_at).toBeInstanceOf(Date);
    expect(JSON.stringify(stored)).not.toContain(clickId);
  });

  it("uses the PostgreSQL advisory lock to serialize partner delivery", async () => {
    const activity = { active: 0, maximum: 0, completed: [] as string[] };
    const deliver = createPartnerRateLimitedDeliverer(
      pool,
      async (row) => {
        activity.active += 1;
        activity.maximum = Math.max(activity.maximum, activity.active);
        await new Promise((resolve) => setTimeout(resolve, 40));
        activity.completed.push(row.id);
        activity.active -= 1;
        return { ok: true };
      },
      { wait: async () => undefined },
    );
    const row = (id: string): OutboxRow => ({
      id,
      event_id: createUuidV7(),
      destination: "partner_tracker",
      payload: { clickid: "Xk8sJ2QpR4vN7bL0aZ9wQg", event: "reg" },
      attempts: 1,
      occurred_at: new Date(),
    });

    await Promise.all([deliver(row("first")), deliver(row("second"))]);

    expect(activity.active).toBe(0);
    expect(activity.maximum).toBe(1);
    expect(new Set(activity.completed)).toEqual(new Set(["first", "second"]));
  });
});
