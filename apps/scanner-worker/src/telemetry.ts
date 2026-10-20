import {
  type MetricSample,
  type SnapshotMetric,
  telemetry,
  telemetryDatabase,
} from "@agentify/observability";
import type { WorkerHealth } from "./health.js";

type NumberValue = number | string;
export type ScanObservation = {
  queued: NumberValue;
  queue_age: NumberValue;
  running: NumberValue;
  stale_running: NumberValue;
  accepted: NumberValue;
  completed: NumberValue;
  partial: NumberValue;
  failed: NumberValue;
  duration_count: NumberValue;
  p50: NumberValue | null;
  p95: NumberValue | null;
};
export type OutboxObservation = { status: string; count: NumberValue; retry_lag: NumberValue };

const definition = (name: string, help: string, labelNames?: string[]): SnapshotMetric => ({
  name,
  help,
  ...(labelNames ? { labelNames } : {}),
});
const scannerMetricDefinitions: SnapshotMetric[] = [
  definition("agentify_scanner_queued", "Unique scans accepted or queued and not yet running"),
  definition(
    "agentify_scanner_queue_age_seconds",
    "Age since acceptance of the oldest waiting scan",
  ),
  definition("agentify_scanner_running", "Scans currently running"),
  definition("agentify_scanner_stale_running", "Running scans with no heartbeat in 30 seconds"),
  definition("agentify_scanner_accepted_recent", "Unique scans accepted in the last 15 minutes"),
  definition(
    "agentify_scanner_completed_recent",
    "Unique scans finished in the last 15 minutes by terminal result",
    ["status"],
  ),
  definition(
    "agentify_scanner_completion_duration_seconds",
    "Acceptance-to-completion duration for completed and partial scans finished in the last 15 minutes",
    ["quantile"],
  ),
  definition(
    "agentify_scanner_completion_observations",
    "Number of scans in the completion duration observation",
  ),
  definition("agentify_analytics_outbox", "Undelivered analytics rows by status", ["status"]),
  definition(
    "agentify_analytics_retry_lag_seconds",
    "Time past next_attempt_at for pending and processing analytics deliveries",
  ),
];

export const SCANNER_SNAPSHOT_QUERY = `select
  count(*) filter (where status in ('accepted','queued')) as queued,
  coalesce(greatest(0, extract(epoch from ($1::timestamptz - min(accepted_at)
    filter (where status in ('accepted','queued'))))), 0) as queue_age,
  count(*) filter (where status = 'running') as running,
  count(*) filter (where status = 'running' and
    (worker_heartbeat_at is null or worker_heartbeat_at < $1::timestamptz - interval '30 seconds')) as stale_running,
  count(*) filter (where accepted_at >= $1::timestamptz - interval '15 minutes') as accepted,
  count(*) filter (where status = 'completed' and finished_at >= $1::timestamptz - interval '15 minutes') as completed,
  count(*) filter (where status = 'partial' and finished_at >= $1::timestamptz - interval '15 minutes') as partial,
  count(*) filter (where status = 'failed' and finished_at >= $1::timestamptz - interval '15 minutes') as failed,
  count(*) filter (where status in ('completed','partial') and finished_at >= $1::timestamptz - interval '15 minutes') as duration_count,
  percentile_cont(0.5) within group (order by extract(epoch from (finished_at - accepted_at)))
    filter (where status in ('completed','partial') and finished_at >= $1::timestamptz - interval '15 minutes') as p50,
  percentile_cont(0.95) within group (order by extract(epoch from (finished_at - accepted_at)))
    filter (where status in ('completed','partial') and finished_at >= $1::timestamptz - interval '15 minutes') as p95
  from scans where status in ('accepted','queued','running')
    or accepted_at >= $1::timestamptz - interval '15 minutes'
    or finished_at >= $1::timestamptz - interval '15 minutes'`;

export const OUTBOX_SNAPSHOT_QUERY = `select status, count(*) as count,
  greatest(0, extract(epoch from ($1::timestamptz - min(next_attempt_at)))) as retry_lag
  from delivery_outbox where status in ('pending','processing','dead_letter') group by status`;

export function scannerSamples(scan: ScanObservation, outbox: OutboxObservation[]): MetricSample[] {
  const point = (name: string, value: NumberValue): MetricSample => ({
    name,
    value: Number(value),
  });
  const waiting = new Map(["pending", "processing", "dead_letter"].map((status) => [status, 0]));
  let retryLag = 0;
  for (const row of outbox) {
    if (!waiting.has(row.status)) throw new Error("invalid_outbox_status");
    waiting.set(row.status, Number(row.count));
    if (row.status !== "dead_letter") retryLag = Math.max(retryLag, Number(row.retry_lag));
  }
  return [
    point("agentify_scanner_queued", scan.queued),
    point("agentify_scanner_queue_age_seconds", scan.queue_age),
    point("agentify_scanner_running", scan.running),
    point("agentify_scanner_stale_running", scan.stale_running),
    point("agentify_scanner_accepted_recent", scan.accepted),
    ...(["completed", "partial", "failed"] as const).map((status) => ({
      ...point("agentify_scanner_completed_recent", scan[status]),
      labels: { status },
    })),
    ...(
      [
        ["0.5", scan.p50],
        ["0.95", scan.p95],
      ] as const
    ).flatMap(([quantile, value]) =>
      value === null
        ? []
        : [
            {
              ...point("agentify_scanner_completion_duration_seconds", value),
              labels: { quantile },
            },
          ],
    ),
    point("agentify_scanner_completion_observations", scan.duration_count),
    ...[...waiting].map(([status, value]) => ({
      ...point("agentify_analytics_outbox", value),
      labels: { status },
    })),
    point("agentify_analytics_retry_lag_seconds", retryLag),
  ];
}

export function startScannerTelemetry(
  databaseUrl: string,
  health: WorkerHealth,
): () => Promise<void> {
  const pool = telemetryDatabase(databaseUrl);
  const stopScanner = telemetry.snapshot("scanner", scannerMetricDefinitions, async () => {
    const at = new Date();
    const scan = await pool.query<ScanObservation>(SCANNER_SNAPSHOT_QUERY, [at]);
    const outbox = await pool.query<OutboxObservation>(OUTBOX_SNAPSHOT_QUERY, [at]);
    if (!scan.rows[0]) throw new Error("missing_scan_observation");
    return scannerSamples(scan.rows[0], outbox.rows);
  });
  const stopReadiness = telemetry.snapshot(
    "worker_readiness",
    [
      definition("agentify_worker_ready", "Worker's own current readiness"),
      definition(
        "agentify_worker_dependency_up",
        "Worker's own current dependency connection state",
        ["dependency"],
      ),
      definition(
        "agentify_worker_heartbeat_timestamp_seconds",
        "Worker's last successfully stored heartbeat timestamp",
      ),
    ],
    async () => [
      { name: "agentify_worker_ready", value: Number(health.ready) },
      {
        name: "agentify_worker_dependency_up",
        labels: { dependency: "database" },
        value: Number(health.databaseConnected),
      },
      {
        name: "agentify_worker_dependency_up",
        labels: { dependency: "queue" },
        value: Number(health.queueConnected),
      },
      {
        name: "agentify_worker_heartbeat_timestamp_seconds",
        value: health.lastHeartbeatAt === null ? 0 : Date.parse(health.lastHeartbeatAt) / 1_000,
      },
    ],
  );
  return async () => {
    stopScanner();
    stopReadiness();
    await pool.end();
  };
}
