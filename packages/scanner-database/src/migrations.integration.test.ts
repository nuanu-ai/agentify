import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BROWSER_OBSERVATION_IDS,
  BROWSER_OBSERVATION_VERSION,
  type CheckResult,
  type ScanJobV1,
} from "@agentify/scanner-contracts";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { createBusinessEventStore, insertBusinessEventOnce } from "./analytics-event-store.js";
import { emitStoredBusinessEvent } from "./analytics-runtime.js";
import { createBrowserObservationRepository } from "./browser-observation-repository.js";
import { createDatabase } from "./client.js";
import { recordWorkerHeartbeat } from "./heartbeat.js";
import { createUuidV7 } from "./ids.js";
import { migrateDatabase } from "./migrate.js";
import { createScanJobRepository } from "./scan-job-repository.js";

const TABLES = [
  "analytics_events",
  "browser_observation_findings",
  "browser_observation_budget_days",
  "browser_observations",
  "consent_snapshots",
  "delivery_outbox",
  "lead_scans",
  "leads",
  "merchant_applications",
  "payment_signals",
  "rate_limit_events",
  "rate_windows",
  "registration_intents",
  "scanner_identity_deletion_operations",
  "scan_checks",
  "scan_fingerprints",
  "scan_shares",
  "scan_snapshots",
  "scans",
  "sessions",
  "waitlist_entries",
  "webhook_receipts",
  "worker_heartbeats",
] as const;

// This suite drops and remakes every schema it is pointed at, so it refuses to
// run rather than falling back to an address nobody chose. The stack's own
// server carries the database it wants: `docker compose up -d --wait postgres`.
const parsed = z
  .url({ protocol: /^postgres(ql)?$/ })
  .safeParse(process.env.MIGRATION_TEST_DATABASE_URL);
if (!parsed.success) {
  throw new Error(
    "MIGRATION_TEST_DATABASE_URL names the database this suite may empty, and it is not set to a" +
      " PostgreSQL address. Copy .env.scanner.example to .env.scanner and start the stack's" +
      " server with `docker compose up -d --wait postgres`.",
  );
}
const connectionString = parsed.data;
const databaseName = new URL(connectionString).pathname.slice(1);
if (!databaseName.endsWith("_migration_test")) {
  throw new Error("MIGRATION_TEST_DATABASE_URL must name a dedicated *_migration_test database");
}

const migrationsFolder = fileURLToPath(new URL("../migrations", import.meta.url));
const downFile = fileURLToPath(new URL("../scripts/0000_initial.down.sql", import.meta.url));
const adminPool = new Pool({ connectionString, max: 1 });

async function resetDatabase(): Promise<void> {
  await adminPool.query(
    "drop schema if exists public cascade; drop schema if exists drizzle cascade; drop schema if exists pgboss cascade; create schema public",
  );
}

beforeAll(async () => {
  await resetDatabase();
});

afterAll(async () => {
  await resetDatabase();
  await adminPool.end();
});

describe("initial database migration", () => {
  it("migrates up, enforces RLS and idempotency, migrates down, then migrates up again", async () => {
    const { db, pool } = createDatabase(connectionString, { max: 5 });
    try {
      await migrateDatabase(db, migrationsFolder);

      const tableRows = await pool.query<{
        tablename: string;
        rowsecurity: boolean;
      }>(
        "select tablename, rowsecurity from pg_tables where schemaname = 'public' order by tablename",
      );
      expect(tableRows.rows.map(({ tablename }) => tablename)).toEqual([...TABLES].sort());
      expect(tableRows.rows.every(({ rowsecurity }) => rowsecurity)).toBe(true);

      const oldWorkerStart = new Date("2026-07-12T10:00:00.000Z");
      const newWorkerStart = new Date("2026-07-12T11:00:00.000Z");
      await recordWorkerHeartbeat(db, {
        workerId: "restart-fence-worker",
        service: "scanner-worker",
        startedAt: oldWorkerStart,
        metadata: { generation: "old" },
      });
      await recordWorkerHeartbeat(db, {
        workerId: "restart-fence-worker",
        service: "scanner-worker",
        startedAt: newWorkerStart,
        metadata: { generation: "new" },
      });
      await recordWorkerHeartbeat(db, {
        workerId: "restart-fence-worker",
        service: "scanner-worker",
        startedAt: oldWorkerStart,
        metadata: { generation: "stale" },
      });
      const restartFence = await pool.query<{
        started_at: Date;
        metadata: { generation: string };
      }>(
        "select started_at, metadata from worker_heartbeats where worker_id = 'restart-fence-worker'",
      );
      expect(restartFence.rows[0]?.started_at.toISOString()).toBe(newWorkerStart.toISOString());
      expect(restartFence.rows[0]?.metadata).toEqual({ generation: "new" });

      const sessionId = createUuidV7();
      await pool.query("insert into sessions (id, anonymous_id_hash) values ($1, $2)", [
        sessionId,
        "anon-hash",
      ]);
      const scanValues = [
        createUuidV7(),
        sessionId,
        "store",
        "gtm-v1.0.0",
        "https://example.com/",
        "https://example.com/",
        "example.com",
        "target-hash",
        "token-hash",
        new Date(Date.now() + 3_600_000),
        "idem-hash",
        "idem-body-hash",
      ];
      const insertScan = `insert into scans
        (id, session_id, segment, rubric_version, submitted_url_redacted, canonical_target_url,
         target_host, target_hash, access_token_hash, access_token_expires_at, idempotency_key_hash,
         idempotency_body_hash)
        values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`;
      await pool.query(insertScan, scanValues);
      await expect(
        pool.query(insertScan, [createUuidV7(), ...scanValues.slice(1)]),
      ).rejects.toMatchObject({
        code: "23505",
      });
      await expect(
        pool.query(
          "insert into sessions (id, anonymous_id_hash) values ('550e8400-e29b-41d4-a716-446655440000', 'bad-v4')",
        ),
      ).rejects.toMatchObject({ code: "23514" });

      const browserObservationId = createUuidV7();
      const browserOperationId = createUuidV7();
      await pool.query(
        `insert into browser_observations
          (id, scan_id, observation_version, operation_id, operation_key,
           actor_id, actor_build)
         values ($1, $2, 'browser-public-v1.0.0', $3, $4, $5, $6)`,
        [
          browserObservationId,
          scanValues[0],
          browserOperationId,
          `browser:${scanValues[0]}`,
          "owner/agentify-browser-observer",
          "1.0.42",
        ],
      );
      const browserRepository = createBrowserObservationRepository(db);
      const browserJob = {
        observation_id: browserObservationId,
        operation_id: browserOperationId,
        attempt_no: 1 as const,
      };
      const firstLease = await browserRepository.claim(
        browserJob,
        new Date("2026-07-13T00:00:00.000Z"),
        1_000,
      );
      expect(firstLease.state).toBe("claimed");
      const secondLease = await browserRepository.claim(
        browserJob,
        new Date("2026-07-13T00:00:01.001Z"),
        1_000,
      );
      expect(secondLease.state).toBe("claimed");
      if (firstLease.state !== "claimed" || secondLease.state !== "claimed")
        throw new Error("browser lease setup failed");
      expect(secondLease.observation.leaseToken).not.toBe(firstLease.observation.leaseToken);
      await expect(
        browserRepository.attachRun(
          browserObservationId,
          firstLease.observation.leaseToken,
          "stale-run",
          new Date("2026-07-13T00:00:01.001Z"),
          1_000,
        ),
      ).resolves.toBe("owned_elsewhere");
      await expect(
        browserRepository.attachRun(
          browserObservationId,
          secondLease.observation.leaseToken,
          "current-run",
          new Date("2026-07-13T00:00:01.001Z"),
          1_000,
        ),
      ).resolves.toBe("attached");
      await expect(
        browserRepository.heartbeat(
          browserObservationId,
          firstLease.observation.leaseToken,
          new Date("2026-07-13T00:00:01.002Z"),
          1_000,
        ),
      ).resolves.toBe(false);
      const staleOutput = {
        schema_version: BROWSER_OBSERVATION_VERSION,
        operation_id: browserOperationId,
        actor_build: "1.0.42",
        status: "completed" as const,
        pages_assessed: 1,
        signals: {
          rendered_text_chars: 1,
          raw_to_rendered_ratio: 1,
          landmark_counts: {},
          heading_level_counts: {},
          interactive_control_count: 0,
          unnamed_control_count: 0,
          form_control_count: 0,
          unlabeled_form_control_count: 0,
          webmcp_present: false,
          webmcp_tool_count: 0,
          console_error_categories: [],
          failed_resource_categories: [],
          mixed_content_count: 0,
          dom_node_count: 1,
          script_count: 0,
          request_count: 1,
          transferred_bytes: 1,
          challenge_kind: null,
        },
        observations: BROWSER_OBSERVATION_IDS.map((id) => ({
          id,
          status: "unavailable" as const,
          summary_code: "browser_observation_unavailable",
          evidence: {},
        })),
        timings: { total_ms: 1, pages: [1] },
      };
      await expect(
        browserRepository.complete(
          browserObservationId,
          firstLease.observation.leaseToken,
          staleOutput,
          { usageUsd: 0.01, finishedAt: new Date("2026-07-13T00:00:01.002Z") },
        ),
      ).resolves.toBe("fenced");
      await expect(
        browserRepository.markTerminal(
          browserObservationId,
          firstLease.observation.leaseToken,
          "failed",
          "stale_worker_must_not_commit",
          { at: new Date("2026-07-13T00:00:01.003Z") },
        ),
      ).resolves.toBe(false);
      await expect(
        browserRepository.markTerminal(
          browserObservationId,
          secondLease.observation.leaseToken,
          "failed",
          "current_worker_commit",
          { at: new Date("2026-07-13T00:00:01.004Z"), usageUsd: 0 },
        ),
      ).resolves.toBe(true);

      const budgetRows: Array<{
        observationId: string;
        operationId: string;
        leaseToken: string;
      }> = [];
      for (const index of [0, 1]) {
        const budgetScanId = createUuidV7();
        await pool.query(insertScan, [
          budgetScanId,
          sessionId,
          "owner",
          "gtm-v1.0.0",
          `https://budget-${index}.example/`,
          `https://budget-${index}.example/`,
          `budget-${index}.example`,
          `budget-target-${index}`,
          `budget-token-${index}`,
          new Date(Date.now() + 3_600_000),
          `budget-idem-${index}`,
          `budget-body-${index}`,
        ]);
        const observationId = createUuidV7();
        const operationId = createUuidV7();
        await pool.query(
          `insert into browser_observations
            (id, scan_id, observation_version, operation_id, operation_key,
             actor_id, actor_build)
           values ($1, $2, 'browser-public-v1.0.0', $3, $4, $5, $6)`,
          [
            observationId,
            budgetScanId,
            operationId,
            `budget-operation-${index}`,
            "owner/agentify-browser-observer",
            "1.0.42",
          ],
        );
        const claim = await browserRepository.claim(
          {
            observation_id: observationId,
            operation_id: operationId,
            attempt_no: 1,
          },
          new Date("2026-07-13T02:00:00.000Z"),
        );
        if (claim.state !== "claimed") throw new Error("budget claim failed");
        budgetRows.push({
          observationId,
          operationId,
          leaseToken: claim.observation.leaseToken,
        });
      }
      const budgetResults = await Promise.all(
        budgetRows.map((row) =>
          browserRepository.reserveDailyBudget(
            row.observationId,
            row.leaseToken,
            0.05,
            0.05,
            new Date("2026-07-13T02:00:01.000Z"),
          ),
        ),
      );
      expect([...budgetResults].sort()).toEqual(["exhausted", "reserved"]);
      const reservedIndex = budgetResults.indexOf("reserved");
      const reservedRow = budgetRows[reservedIndex];
      if (!reservedRow) throw new Error("no row reserved the browser observation budget");
      await expect(
        browserRepository.attachRun(
          reservedRow.observationId,
          reservedRow.leaseToken,
          "budget-run-final-cost",
          new Date("2026-07-13T02:00:01.500Z"),
        ),
      ).resolves.toBe("attached");
      await expect(
        browserRepository.markTerminal(
          reservedRow.observationId,
          reservedRow.leaseToken,
          "failed",
          "provider_failed",
          {
            at: new Date("2026-07-13T02:00:02.000Z"),
            usageUsd: 0.002521,
          },
        ),
      ).resolves.toBe(true);
      const budgetLedger = await pool.query<{
        reserved_usd: string;
        usage_usd: string;
      }>(
        "select reserved_usd::text, usage_usd::text from browser_observation_budget_days where budget_day = '2026-07-13'",
      );
      expect(Number(budgetLedger.rows[0]?.reserved_usd)).toBe(0.047479);
      expect(Number(budgetLedger.rows[0]?.usage_usd)).toBe(0.002521);

      const reconciliation = await browserRepository.reconcileUsage(
        reservedRow.observationId,
        "budget-run-final-cost",
        0.002566,
        new Date("2026-07-13T02:31:00.000Z"),
      );
      expect(reconciliation.state).toBe("updated");
      expect(reconciliation.deltaUsd).toBeCloseTo(0.000045, 10);
      expect(reconciliation.dayTotalUsd).toBe(0.002566);
      await expect(
        browserRepository.reconcileUsage(
          reservedRow.observationId,
          "budget-run-final-cost",
          0.002566,
          new Date("2026-07-13T02:32:00.000Z"),
        ),
      ).resolves.toEqual({
        state: "unchanged",
        deltaUsd: 0,
        dayTotalUsd: 0.002566,
      });
      const reconciledBudget = await pool.query<{
        reserved_usd: string;
        usage_usd: string;
        observation_reserved_usd: string;
        observation_usage_usd: string;
        usage_reconciled_at: Date | null;
      }>(
        `select budget.reserved_usd::text, budget.usage_usd::text,
          observation.budget_reserved_usd::text as observation_reserved_usd,
          observation.usage_usd::text as observation_usage_usd,
          observation.usage_reconciled_at
        from browser_observation_budget_days budget
        join browser_observations observation
          on observation.budget_day = budget.budget_day
        where observation.id = $1`,
        [reservedRow.observationId],
      );
      expect(Number(reconciledBudget.rows[0]?.reserved_usd)).toBe(0);
      expect(Number(reconciledBudget.rows[0]?.usage_usd)).toBe(0.002566);
      expect(Number(reconciledBudget.rows[0]?.observation_reserved_usd)).toBe(0);
      expect(Number(reconciledBudget.rows[0]?.observation_usage_usd)).toBe(0.002566);
      expect(reconciledBudget.rows[0]?.usage_reconciled_at).toBeInstanceOf(Date);

      await expect(
        pool.query(
          `insert into browser_observations
            (id, scan_id, observation_version, operation_id, operation_key,
             actor_id, actor_build)
           values ($1, $2, 'browser-public-v1.0.0', $3, $4, $5, $6)`,
          [
            createUuidV7(),
            scanValues[0],
            createUuidV7(),
            "duplicate-operation",
            "owner/agentify-browser-observer",
            "1.0.42",
          ],
        ),
      ).rejects.toMatchObject({ code: "23505" });
      await expect(
        pool.query(
          `insert into browser_observation_findings
            (observation_id, finding_id, status, summary_code)
           values ($1, 'form_semantics', 'pending', 'pending_is_invalid')`,
          [browserObservationId],
        ),
      ).rejects.toMatchObject({ code: "23514" });

      const consentSnapshotId = createUuidV7();
      await pool.query(
        "insert into consent_snapshots (id, session_id, policy_version, categories, source) values ($1, $2, 'consent-v1.0.0', $3, 'api')",
        [
          consentSnapshotId,
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

      const repository = createScanJobRepository(db);
      const scanJob: ScanJobV1 = {
        scan_id: scanValues[0] as string,
        canonical_target_url: "https://example.com/",
        segment: "store",
        rubric_version: "gtm-v1.0.0",
        deadline_at: new Date(Date.now() + 55_000).toISOString(),
        attempt_no: 1,
      };
      const scanCheck: CheckResult = {
        id: 1,
        status: "pass",
        nominalWeight: 5,
        applicableWeight: 5,
        earnedWeight: 5,
        summaryCode: "robots_parseable",
        evidence: { status: 200 },
        userImpactCode: "robots_policy_discoverability",
        durationMs: 1,
      };
      await expect(repository.claim(scanJob)).resolves.toBe("claimed");
      await expect(repository.upsertCheck(scanJob.scan_id, 1, scanCheck, new Date())).resolves.toBe(
        true,
      );
      await expect(repository.claim({ ...scanJob, attempt_no: 2 })).resolves.toBe("claimed");
      await expect(repository.upsertCheck(scanJob.scan_id, 1, scanCheck, new Date())).resolves.toBe(
        false,
      );
      await expect(
        repository.upsertCheck(
          scanJob.scan_id,
          2,
          { ...scanCheck, summaryCode: "fresh_attempt_check" },
          new Date(),
        ),
      ).resolves.toBe(true);
      const staleCommit = await repository.commitTerminal({
        scanId: scanJob.scan_id,
        attemptNo: 1,
        evaluation: {
          checks: [scanCheck],
          score: {
            rubricVersion: "gtm-v1.0.0",
            score: 100,
            coverage: 1,
            level: "ahead_of_market",
            terminalStatus: "completed",
            nominalWeight: 5,
            applicableWeight: 5,
            assessedWeight: 5,
            earnedWeight: 5,
          },
          fingerprint: {
            detectorVersion: "scanner-fingerprint-v1",
            platform: { value: "unknown", confidence: "low", signals: [] },
            wafCdn: [],
            pspMarkers: [],
          },
          findings: { negativeCheckIds: [] },
        },
        cacheKey: "stale-attempt-cache-key",
        cacheHit: false,
        finishedAt: new Date(),
      });
      expect(staleCommit).toBe("already_terminal");
      const fencedState = await pool.query<{
        status: string;
        attempt_no: number;
        summary_code: string;
        fingerprints: string;
        snapshots: string;
        completed_events: string;
      }>(
        `select s.status, s.attempt_no, c.summary_code,
           (select count(*) from scan_fingerprints where scan_id = s.id)::text as fingerprints,
           (select count(*) from scan_snapshots where id = s.id)::text as snapshots,
           (select count(*) from analytics_events where name = 'scan_completed' and scan_id = s.id)::text as completed_events
         from scans s
         join scan_checks c on c.scan_id = s.id and c.check_id = 1
         where s.id = $1`,
        [scanJob.scan_id],
      );
      expect(fencedState.rows[0]).toEqual({
        status: "running",
        attempt_no: 2,
        summary_code: "fresh_attempt_check",
        fingerprints: "0",
        snapshots: "0",
        completed_events: "0",
      });

      const eventId = createUuidV7();
      const store = createBusinessEventStore(db);
      const eventInput = {
        onceKey: `landing_view:${sessionId}:store-v1:2026-07-12`,
        event: {
          eventId,
          name: "landing_view" as const,
          occurredAt: "2026-07-12T12:00:00.000Z",
          pseudonymousId: "anon_test",
          segment: "store" as const,
          landingVariant: "store-v1",
          properties: { day: "2026-07-12" },
        },
        context: { sessionId, consentSnapshotId },
        outbox: [
          {
            eventId,
            destination: "posthog" as const,
            payload: { event: "landing_view" },
          },
          { eventId, destination: "meta" as const, payload: { data: [] } },
        ],
      };
      await expect(store.insertOnce(eventInput)).resolves.toEqual({
        inserted: true,
        eventId,
      });
      await expect(
        store.insertOnce({
          ...eventInput,
          event: { ...eventInput.event, eventId: createUuidV7() },
        }),
      ).resolves.toEqual({ inserted: false, eventId });
      const storedEvents = await pool.query<{ count: string }>(
        "select count(*)::text as count from analytics_events where once_key = $1",
        [eventInput.onceKey],
      );
      const storedOutbox = await pool.query<{ count: string }>(
        "select count(*)::text as count from delivery_outbox where event_id = $1",
        [eventId],
      );
      expect(storedEvents.rows[0]?.count).toBe("1");
      expect(storedOutbox.rows[0]?.count).toBe("2");

      const rollbackOnceKey = `results_viewed:${sessionId}:rollback-scan`;
      const rollbackEventId = createUuidV7();
      await expect(
        db.transaction(async (tx) => {
          await insertBusinessEventOnce(tx, {
            ...eventInput,
            onceKey: rollbackOnceKey,
            event: {
              ...eventInput.event,
              eventId: rollbackEventId,
              name: "results_viewed",
            },
            outbox: [
              {
                eventId: rollbackEventId,
                destination: "posthog",
                payload: { event: "results_viewed" },
              },
            ],
          });
          throw new Error("force_outer_transaction_rollback");
        }),
      ).rejects.toThrow("force_outer_transaction_rollback");
      const rolledBack = await pool.query<{ events: string; outbox: string }>(
        `select
           (select count(*) from analytics_events where once_key = $1)::text as events,
           (select count(*) from delivery_outbox where event_id = $2)::text as outbox`,
        [rollbackOnceKey, rollbackEventId],
      );
      expect(rolledBack.rows[0]).toEqual({ events: "0", outbox: "0" });

      const concurrentOnceKey = `registration_started:${sessionId}:concurrent-scan`;
      const concurrentResults = await Promise.all(
        Array.from({ length: 6 }, async () => {
          const candidateEventId = createUuidV7();
          return await store.insertOnce({
            ...eventInput,
            onceKey: concurrentOnceKey,
            event: {
              ...eventInput.event,
              eventId: candidateEventId,
              name: "registration_started",
            },
            outbox: [
              {
                eventId: candidateEventId,
                destination: "posthog",
                payload: { event: "registration_started" },
              },
            ],
          });
        }),
      );
      expect(concurrentResults.filter(({ inserted }) => inserted)).toHaveLength(1);
      expect(new Set(concurrentResults.map(({ eventId: id }) => id)).size).toBe(1);
      const [firstConcurrent] = concurrentResults;
      if (!firstConcurrent) throw new Error("the concurrent inserts answered with nothing");
      const concurrentEventId = firstConcurrent.eventId;
      const concurrentStored = await pool.query<{
        events: string;
        outbox: string;
      }>(
        `select
           (select count(*) from analytics_events where once_key = $1)::text as events,
           (select count(*) from delivery_outbox where event_id = $2)::text as outbox`,
        [concurrentOnceKey, concurrentEventId],
      );
      expect(concurrentStored.rows[0]).toEqual({ events: "1", outbox: "1" });

      process.env.ANALYTICS_RUNTIME_ENV = "test";
      process.env.ANALYTICS_SERVER_DELIVERY_ENABLED = "true";
      process.env.POSTHOG_API_KEY = "ph_test_project";
      process.env.POSTHOG_DESTINATION_ENV = "test";
      process.env.META_CAPI_ENABLED = "true";
      process.env.META_ACCESS_TOKEN = "meta-test-token";
      process.env.META_DATASET_ID = "meta-test-dataset";
      process.env.META_DESTINATION_ENV = "test";

      const runtimeAllowed = await emitStoredBusinessEvent(db, {
        name: "results_viewed",
        identifiers: {
          session_id: sessionId,
          scan_id: scanValues[0] as string,
        },
        sessionId,
        consentSnapshotId,
        scanId: scanValues[0] as string,
        segment: "store",
        landingVariant: "store-v1",
        properties: {
          coverage_band: "high",
          scanned_url: "https://example.com/private?token=nope",
        },
      });
      const runtimeAllowedOutbox = await pool.query<{
        count: string;
        payload: string;
      }>(
        "select count(*)::text as count, string_agg(payload::text, '') as payload from delivery_outbox where event_id = $1",
        [runtimeAllowed.eventId],
      );
      expect(runtimeAllowedOutbox.rows[0]?.count).toBe("2");
      expect(runtimeAllowedOutbox.rows[0]?.payload).not.toMatch(/example\.com|token=nope/i);

      const deniedConsentId = createUuidV7();
      await pool.query(
        "insert into consent_snapshots (id, session_id, policy_version, categories, source) values ($1, $2, 'consent-v1.0.0', $3, 'api')",
        [
          deniedConsentId,
          sessionId,
          JSON.stringify({
            essential_processing: true,
            product_analytics: false,
            ads_measurement: false,
            marketing_email: false,
            dataset_reuse: false,
            card_signal: false,
          }),
        ],
      );
      const denied = await emitStoredBusinessEvent(db, {
        name: "landing_view",
        identifiers: {
          session_id: sessionId,
          variant: "store-denied-v1",
          day: "2026-07-12",
        },
        sessionId,
        consentSnapshotId: deniedConsentId,
        segment: "store",
        landingVariant: "store-denied-v1",
      });
      const deniedOutbox = await pool.query<{ count: string }>(
        "select count(*)::text as count from delivery_outbox where event_id = $1",
        [denied.eventId],
      );
      expect(deniedOutbox.rows[0]?.count).toBe("0");

      process.env.ANALYTICS_RUNTIME_ENV = "preview";
      process.env.POSTHOG_DESTINATION_ENV = "production";
      await expect(
        emitStoredBusinessEvent(db, {
          name: "registration_started",
          identifiers: {
            session_id: sessionId,
            scan_id: scanValues[0] as string,
          },
          sessionId,
          consentSnapshotId,
          scanId: scanValues[0] as string,
          segment: "store",
          landingVariant: "store-v1",
        }),
      ).rejects.toThrow("posthog_environment_mismatch");
      process.env.ANALYTICS_SERVER_DELIVERY_ENABLED = "false";

      const downSql = await readFile(downFile, "utf8");
      await pool.query(downSql);
      const afterDown = await pool.query<{ count: string }>(
        "select count(*)::text as count from pg_tables where schemaname = 'public' and tablename = any($1)",
        [TABLES],
      );
      expect(afterDown.rows[0]?.count).toBe("0");

      await migrateDatabase(db, migrationsFolder);
      const afterSecondUp = await pool.query<{ count: string }>(
        "select count(*)::text as count from pg_tables where schemaname = 'public' and tablename = any($1)",
        [TABLES],
      );
      expect(afterSecondUp.rows[0]?.count).toBe(String(TABLES.length));
    } finally {
      await pool.end();
    }
  }, 20_000);
});

/**
 * The one database holds three migration sets, and drizzle's migrator applies
 * every file dated after the newest entry of the history it reads and compares
 * nothing else. So each set keeps a history of its own: sharing one, a set
 * would skip the other's older files as though they had run. The gateway's
 * and the cabinet's are applied the way their own commands apply them
 * (apps/gateway/src/migrate.ts, apps/cabinet/src/database.ts).
 */
describe("the scanner's migrations in the one database", () => {
  const gatewayMigrations = fileURLToPath(
    new URL("../../../apps/gateway/drizzle", import.meta.url),
  );
  const cabinetMigrations = fileURLToPath(
    new URL("../../../apps/cabinet/drizzle", import.meta.url),
  );
  const entries = async (folder: string): Promise<number> =>
    JSON.parse(await readFile(join(folder, "meta", "_journal.json"), "utf8")).entries.length;

  it("run beside the gateway's and the cabinet's, and none of the three skips or repeats another's", async () => {
    await resetDatabase();
    const { db, pool } = createDatabase(connectionString, { max: 2 });
    // A gateway migration written after the scanner's newest file but dated
    // before it, as a branch that waited in review would be.
    const later = await mkdtemp(join(tmpdir(), "gateway-migrations-"));
    try {
      const gateway = async (folder: string) =>
        migrate(drizzle(pool), { migrationsFolder: folder });
      const cabinet = async () =>
        migrate(drizzle(pool), {
          migrationsFolder: cabinetMigrations,
          migrationsTable: "cabinet_migrations",
        });
      await gateway(gatewayMigrations);
      await cabinet();
      await migrateDatabase(db, migrationsFolder);

      const tables = await pool.query<{ tablename: string }>(
        "select tablename from pg_tables where schemaname = 'public'",
      );
      expect(tables.rows.map(({ tablename }) => tablename)).toEqual(
        expect.arrayContaining([...TABLES, "orders", "cabinet_accounts"]),
      );
      const histories = async () =>
        (
          await pool.query<{ table_name: string; count: string }>(
            `select 'gateway' as table_name, count(*)::text from drizzle.__drizzle_migrations
             union all select 'cabinet', count(*)::text from drizzle.cabinet_migrations
             union all select 'scanner', count(*)::text from drizzle.scanner_migrations`,
          )
        ).rows;
      expect(await histories()).toEqual([
        { table_name: "gateway", count: String(await entries(gatewayMigrations)) },
        { table_name: "cabinet", count: String(await entries(cabinetMigrations)) },
        { table_name: "scanner", count: String(await entries(migrationsFolder)) },
      ]);

      await gateway(gatewayMigrations);
      await cabinet();
      await migrateDatabase(db, migrationsFolder);
      const unchanged = await histories();

      const scannerNewest = JSON.parse(
        await readFile(join(migrationsFolder, "meta", "_journal.json"), "utf8"),
      ).entries.at(-1).when;
      await cp(gatewayMigrations, later, { recursive: true });
      const journal = JSON.parse(await readFile(join(later, "meta", "_journal.json"), "utf8"));
      journal.entries.push({
        idx: journal.entries.length,
        version: "7",
        when: scannerNewest - 60_000,
        tag: "9999_waited_in_review",
        breakpoints: true,
      });
      await writeFile(join(later, "meta", "_journal.json"), JSON.stringify(journal));
      await writeFile(
        join(later, "9999_waited_in_review.sql"),
        'CREATE TABLE "waited_in_review" ("id" integer);',
      );
      await gateway(later);

      expect(
        (await pool.query("select to_regclass('public.waited_in_review') is not null as there"))
          .rows[0],
      ).toEqual({ there: true });
      expect(await histories()).toEqual(
        unchanged.map((row) =>
          row.table_name === "gateway" ? { ...row, count: String(Number(row.count) + 1) } : row,
        ),
      );
    } finally {
      await rm(later, { recursive: true, force: true });
      await pool.end();
      await resetDatabase();
    }
  }, 30_000);
});
