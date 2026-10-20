import { fileURLToPath } from "node:url";
import { telemetryDatabase } from "@agentify/observability";
import { createDatabase, createUuidV7, migrateDatabase } from "@agentify/scanner-database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  OUTBOX_SNAPSHOT_QUERY,
  type OutboxObservation,
  SCANNER_SNAPSHOT_QUERY,
  type ScanObservation,
  scannerSamples,
} from "./telemetry.js";

// vitest.db.setup applies the suite's refusal of the stack database before
// this file runs. Use the same explicit overrides and local default.
const url =
  process.env.AGENTIFY_TEST_DATABASE_URL ??
  process.env.DATABASE_URL ??
  "postgres://agentify:agentify@localhost:5432/agentify_test";
const { db, pool } = createDatabase(url);
const reader = telemetryDatabase(url);
const session = createUuidV7();
const consent = createUuidV7();
const event = createUuidV7();
const at = new Date();

beforeAll(async () => {
  await migrateDatabase(
    db,
    fileURLToPath(new URL("../../../packages/scanner-database/migrations", import.meta.url)),
  );
  await pool.query("insert into sessions (id,anonymous_id_hash) values ($1,$2)", [
    session,
    `telemetry-db-test-${session}`,
  ]);
  for (const status of ["queued", "running", "completed", "failed"]) {
    await pool.query(
      `insert into scans (id,session_id,segment,rubric_version,submitted_url_redacted,
      canonical_target_url,target_host,target_hash,status,accepted_at,worker_heartbeat_at,
      finished_at,score,coverage,access_token_hash,access_token_expires_at,idempotency_key_hash,idempotency_body_hash)
      values ($1::uuid,$2,'store','telemetry-test','https://example.com/','https://example.com/',
        'example.com',$1::text,$3::text::scan_status,$4::timestamptz-interval '20 seconds',$4::timestamptz-interval '60 seconds',
        case when $3 in ('completed','failed') then $4::timestamptz-interval '10 seconds' end,
        case when $3='completed' then 50 end,case when $3='completed' then 1.000 end,
        $1::text,$4::timestamptz+interval '1 hour',$1::text,$1::text)`,
      [createUuidV7(), session, status, at],
    );
  }
  await pool.query(
    "insert into consent_snapshots (id,session_id,policy_version,categories,source) values ($1,$2,'consent-test','{}','api')",
    [consent, session],
  );
  await pool.query(
    `insert into analytics_events (id,event_id,name,occurred_at,session_id,segment,landing_variant,properties,consent_snapshot_id)
    values ($1,$2,'scan_completed',$3,$4,'store','store-v1','{}',$5)`,
    [createUuidV7(), event, at, session, consent],
  );
  await pool.query(
    `insert into delivery_outbox (id,event_id,destination,payload,status,next_attempt_at)
    values ($1,$2,'posthog','{}','processing',$3::timestamptz-interval '123 seconds')`,
    [createUuidV7(), event, at],
  );
});
afterAll(async () => {
  await pool.query("delete from delivery_outbox where event_id=$1", [event]);
  await pool.query("delete from analytics_events where event_id=$1", [event]);
  await pool.query("delete from consent_snapshots where session_id=$1", [session]);
  await pool.query("delete from scans where session_id=$1", [session]);
  await pool.query("delete from sessions where id=$1", [session]);
  await Promise.all([reader.end(), pool.end()]);
});

describe("operational reads on the migrated scanner database", () => {
  it("observes unique scans and an expired processing lease without changing them", async () => {
    const scan = await reader.query<ScanObservation>(SCANNER_SNAPSHOT_QUERY, [at]);
    const outbox = await reader.query<OutboxObservation>(OUTBOX_SNAPSHOT_QUERY, [at]);
    if (!scan.rows[0]) throw new Error("missing scanner observation");
    const samples = scannerSamples(scan.rows[0], outbox.rows);
    const value = (name: string) => samples.find((sample) => sample.name === name)?.value;
    expect(value("agentify_scanner_queued")).toBe(1);
    expect(value("agentify_scanner_stale_running")).toBe(1);
    expect(value("agentify_scanner_completion_observations")).toBe(1);
    expect(value("agentify_analytics_retry_lag_seconds")).toBe(123);
    expect(
      samples.find(
        (sample) =>
          sample.name === "agentify_scanner_completion_duration_seconds" &&
          sample.labels?.quantile === "0.95",
      )?.value,
    ).toBe(10);
  });
});
