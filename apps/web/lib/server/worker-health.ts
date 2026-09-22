import type { DeliveryDestination } from "@agentify/scanner-contracts";

export const READINESS_OUTBOX_DESTINATIONS = [
  "posthog",
  "meta",
] as const satisfies readonly DeliveryDestination[];

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
  queue_age_seconds: string | number | null;
  stale_running: string | number;
  accepted_15m: string | number;
  failed_15m: string | number;
  outbox_age_seconds: string | number | null;
  outbox_dead_letters: string | number;
};

export type OperationalSignalHealth = {
  scannerCapacity: boolean;
  analyticsOutbox: boolean;
};

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
  const heartbeatFresh = Number.isFinite(heartbeatAt) && now.getTime() - heartbeatAt < 30_000;
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
