import { SCAN_RUBRIC_VERSION } from "@agentify/scanner-contracts";

import { getDatabase } from "../../../lib/server/database";
import { logServerError, requestHeaders } from "../../../lib/server/http";
import { methods } from "../../../lib/server/methods";
import {
  evaluateOperationalSignals,
  evaluateWorkerHeartbeat,
  OPERATIONAL_SIGNALS_QUERY,
  type OperationalSignalRow,
  WORKER_HEARTBEAT_QUERY,
  type WorkerHeartbeatRow,
} from "../../../lib/server/worker-health";

async function health(request: Request): Promise<Response> {
  try {
    const [workerResult, signalsResult] = await Promise.all([
      getDatabase().pool.query<WorkerHeartbeatRow>(WORKER_HEARTBEAT_QUERY),
      getDatabase().pool.query<OperationalSignalRow>(OPERATIONAL_SIGNALS_QUERY),
    ]);
    const worker = evaluateWorkerHeartbeat(workerResult.rows[0]);
    const signals = evaluateOperationalSignals(
      signalsResult.rows[0] ?? {
        queue_age_seconds: Number.POSITIVE_INFINITY,
        stale_running: Number.POSITIVE_INFINITY,
        queued_scans: Number.POSITIVE_INFINITY,
        accepted_15m: 0,
        failed_15m: 0,
        outbox_pending: Number.POSITIVE_INFINITY,
        outbox_age_seconds: Number.POSITIVE_INFINITY,
        outbox_dead_letters: Number.POSITIVE_INFINITY,
      },
    );
    const healthy = worker.ready && signals.scannerCapacity && signals.analyticsOutbox;
    return Response.json(
      {
        status: healthy ? "ok" : "degraded",
        service: "web",
        dependencies: {
          database: "ok",
          scanner_worker: worker.ready ? "ok" : "unavailable",
          worker_heartbeat: worker.heartbeatFresh ? "ok" : "stale",
          worker_database: worker.databaseConnected ? "ok" : "unavailable",
          worker_queue: worker.queueConnected ? "ok" : "unavailable",
          scanner_capacity: signals.scannerCapacity ? "ok" : "degraded",
          analytics_outbox: signals.analyticsOutbox ? "ok" : "degraded",
        },
        rubric_version: SCAN_RUBRIC_VERSION,
        timestamp: new Date().toISOString(),
      },
      {
        status: healthy ? 200 : 503,
        headers: requestHeaders(request),
      },
    );
  } catch (error) {
    logServerError(request, "health_check_failed", error, {
      status_code: 503,
      error_code: "database_unavailable",
    });
    return Response.json(
      {
        status: "unavailable",
        service: "web",
        dependencies: { database: "unavailable", scanner_worker: "unknown" },
        rubric_version: SCAN_RUBRIC_VERSION,
        timestamp: new Date().toISOString(),
      },
      { status: 503, headers: requestHeaders(request) },
    );
  }
}

export const loader = methods({ GET: health });
export const action = loader;
