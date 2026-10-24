export type WorkerHeartbeatRow = {
  heartbeat_at: Date | string;
  metadata: unknown;
};

export type WorkerDependencyHealth = {
  ready: boolean;
  heartbeatFresh: boolean;
  queueConnected: boolean;
  databaseConnected: boolean;
};

export type OperationalSignalRow = {
  queued_scans: string | number;
  queue_age_seconds: string | number | null;
  stale_running: string | number;
  accepted_15m: string | number;
  failed_15m: string | number;
  outbox_pending: string | number;
  outbox_age_seconds: string | number | null;
  outbox_dead_letters: string | number;
};

export type OperationalSignalHealth = {
  scannerCapacity: boolean;
  analyticsOutbox: boolean;
};

/**
 * The scanner's health is read by these two queries and judged by the two
 * functions below, for the health check and for the operator's page alike, so
 * the page cannot call the worker healthy by rules of its own.
 */
export const WORKER_HEARTBEAT_QUERY = `
  select heartbeat_at, metadata
  from worker_heartbeats
  where service = 'scanner-worker'
  order by heartbeat_at desc
  limit 1`;

export const OPERATIONAL_SIGNALS_QUERY = `
  select
    (select count(*) from scans where status in ('accepted', 'queued')) as queued_scans,
    coalesce((
      select greatest(0, extract(epoch from (now() - min(accepted_at))))
      from scans where status in ('accepted', 'queued')
    ), 0) as queue_age_seconds,
    (select count(*) from scans
      where status = 'running'
        and (worker_heartbeat_at is null
          or worker_heartbeat_at < now() - interval '30 seconds')) as stale_running,
    (select count(*) from scans
      where accepted_at >= now() - interval '15 minutes') as accepted_15m,
    (select count(*) from scans
      where accepted_at >= now() - interval '15 minutes'
        and status = 'failed') as failed_15m,
    (select count(*) from delivery_outbox where status = 'pending') as outbox_pending,
    coalesce((
      select greatest(0, extract(epoch from (now() - min(next_attempt_at))))
      from delivery_outbox
      where status = 'pending'
    ), 0) as outbox_age_seconds,
    (select count(*) from delivery_outbox
      where status = 'dead_letter') as outbox_dead_letters`;

/** How long a heartbeat stays fresh. */
export const HEARTBEAT_FRESH_MS = 30_000;

const metadataBoolean = (metadata: unknown, key: string): boolean =>
  typeof metadata === "object" &&
  metadata !== null &&
  (metadata as Record<string, unknown>)[key] === true;

export function evaluateWorkerHeartbeat(
  row: WorkerHeartbeatRow | undefined,
  now = new Date(),
): WorkerDependencyHealth {
  if (!row)
    return {
      ready: false,
      heartbeatFresh: false,
      queueConnected: false,
      databaseConnected: false,
    };

  const heartbeatAt = new Date(row.heartbeat_at).getTime();
  const heartbeatFresh =
    Number.isFinite(heartbeatAt) && now.getTime() - heartbeatAt < HEARTBEAT_FRESH_MS;
  const queueConnected = metadataBoolean(row.metadata, "queue_connected");
  const databaseConnected = metadataBoolean(row.metadata, "database_connected");
  const reportedReady = metadataBoolean(row.metadata, "ready");
  return {
    heartbeatFresh,
    queueConnected,
    databaseConnected,
    ready: heartbeatFresh && queueConnected && databaseConnected && reportedReady,
  };
}

const finiteNumber = (value: unknown): number => {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : Number.POSITIVE_INFINITY;
};

export function evaluateOperationalSignals(row: OperationalSignalRow): OperationalSignalHealth {
  const accepted = finiteNumber(row.accepted_15m);
  const failed = finiteNumber(row.failed_15m);
  const failureRate = accepted > 0 ? failed / accepted : 0;
  const queueAge = finiteNumber(row.queue_age_seconds);
  const staleRunning = finiteNumber(row.stale_running);
  const outboxAge = finiteNumber(row.outbox_age_seconds);
  const deadLetters = finiteNumber(row.outbox_dead_letters);
  return {
    scannerCapacity: queueAge <= 10 && staleRunning === 0 && (accepted < 5 || failureRate <= 0.05),
    analyticsOutbox: outboxAge <= 300 && deadLetters === 0,
  };
}
