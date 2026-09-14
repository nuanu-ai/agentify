import { SCAN_RUBRIC_VERSION } from "@b2a/contracts";
import { NextResponse } from "next/server";

import { getDatabase } from "../../../lib/server/database";
import { logServerError, requestHeaders } from "../../../lib/server/http";
import {
  evaluateOperationalSignals,
  evaluateWorkerHeartbeat,
  READINESS_OUTBOX_DESTINATIONS,
  type OperationalSignalRow,
  type WorkerHeartbeatRow,
} from "../../../lib/server/worker-health";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const [workerResult, signalsResult] = await Promise.all([
      getDatabase().pool.query<WorkerHeartbeatRow>(
        `select heartbeat_at, metadata
         from worker_heartbeats
         where service = 'scanner-worker'
         order by heartbeat_at desc
         limit 1`,
      ),
      getDatabase().pool.query<OperationalSignalRow>(
        `select
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
           coalesce((
             select greatest(0, extract(epoch from (now() - min(next_attempt_at))))
             from delivery_outbox
             where status = 'pending'
               and destination = any($1::delivery_destination[])
           ), 0) as outbox_age_seconds,
           (select count(*) from delivery_outbox
             where status = 'dead_letter'
               and destination = any($1::delivery_destination[])) as outbox_dead_letters`,
        [[...READINESS_OUTBOX_DESTINATIONS]],
      ),
    ]);
    const worker = evaluateWorkerHeartbeat(workerResult.rows[0]);
    const signals = evaluateOperationalSignals(
      signalsResult.rows[0] ?? {
        queue_age_seconds: Number.POSITIVE_INFINITY,
        stale_running: Number.POSITIVE_INFINITY,
        accepted_15m: 0,
        failed_15m: 0,
        outbox_age_seconds: Number.POSITIVE_INFINITY,
        outbox_dead_letters: Number.POSITIVE_INFINITY,
      },
    );
    const healthy =
      worker.ready && signals.scannerCapacity && signals.analyticsOutbox;
    return NextResponse.json(
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
    return NextResponse.json(
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
