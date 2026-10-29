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

type Reading = Readonly<{ status: number; body: Record<string, unknown> }>;

/**
 * How long a ready reading answers every check. A probe polls the route and
 * anyone may call it, and each reading runs an aggregate over the scans and
 * the outbox on the pool that serves visitors. A reading that is not ready is
 * shared only while it runs, so a check made once, as a deployment's is, sees
 * a recovery at once.
 */
const READY_KEPT_MS = 5_000;

/**
 * How long a check waits for a reading: under the outside probe's own limit,
 * so the probe sees the answer rather than its own timeout.
 */
const READING_LIMIT_MS = 5_000;
/**
 * The database's own limits on a reading, under the check's, so the server
 * gives up a reading stuck on a lock and frees its connection, rather than
 * leave it held after the check has answered.
 */
const STATEMENT_LIMIT_MS = 4_000;
const LOCK_LIMIT_MS = 3_000;

let inFlight: Promise<Reading> | undefined;
/** A reading the check stopped waiting for that still holds or waits for a connection. */
let overrun: Promise<Reading> | undefined;
let ready: { reading: Reading; takenAt: number } | undefined;

/**
 * One reading for every check that arrives while it runs, and a ready one for
 * a few seconds after. While a reading that ran past its limit is still
 * unsettled, a check is answered that the database's state is unknown, and no
 * second reading is started beside it.
 */
function currentReading(request: Request): Promise<Reading> {
  if (ready && Date.now() - ready.takenAt < READY_KEPT_MS) return Promise.resolve(ready.reading);
  if (inFlight) return inFlight;
  if (overrun) return Promise.resolve(databaseUnknown());
  const reading = read(request);
  const taking = withinLimit(request, reading);
  inFlight = taking;
  void taking.then((answer) => {
    if (inFlight === taking) inFlight = undefined;
    if (answer.status === 200) ready = { reading: answer, takenAt: Date.now() };
  });
  return taking;
}

/** The reading, or the database's state called unknown once the limit passes without it. */
function withinLimit(request: Request, reading: Promise<Reading>): Promise<Reading> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<Reading>((resolve) => {
    timer = setTimeout(() => {
      logServerError(request, "health_check_failed", new Error("health_reading_timed_out"), {
        status_code: 503,
        error_code: "database_timeout",
      });
      overrun = reading;
      void reading.finally(() => {
        if (overrun === reading) overrun = undefined;
      });
      resolve(databaseUnknown());
    }, READING_LIMIT_MS);
  });
  return Promise.race([reading, late]).finally(() => clearTimeout(timer));
}

const notReady = (database: "unavailable" | "unknown"): Reading => ({
  status: 503,
  body: {
    status: "unavailable",
    service: "web",
    dependencies: { database, scanner_worker: "unknown" },
    rubric_version: SCAN_RUBRIC_VERSION,
    timestamp: new Date().toISOString(),
  },
});
/** The database did not answer in time: it may be down, or only slow or locked. */
const databaseUnknown = () => notReady("unknown");

/** Postgres's codes for a statement cancelled at its time limit and a lock not had in time. */
const TIMED_OUT = new Set(["57014", "55P03"]);

/** The two queries in one transaction under the database's own limits, on one connection. */
async function readSignals(): Promise<
  readonly [WorkerHeartbeatRow | undefined, OperationalSignalRow | undefined]
> {
  const client = await getDatabase().pool.connect();
  try {
    await client.query(
      `begin; set local statement_timeout = ${STATEMENT_LIMIT_MS}; set local lock_timeout = ${LOCK_LIMIT_MS}`,
    );
    const worker = await client.query<WorkerHeartbeatRow>(WORKER_HEARTBEAT_QUERY);
    const signals = await client.query<OperationalSignalRow>(OPERATIONAL_SIGNALS_QUERY);
    await client.query("commit");
    client.release();
    return [worker.rows[0], signals.rows[0]];
  } catch (error) {
    // A connection whose transaction cannot be closed is not handed back to visitors.
    const closed = await client.query("rollback").then(
      () => true,
      () => false,
    );
    client.release(!closed);
    throw error;
  }
}

async function health(request: Request): Promise<Response> {
  const { status, body } = await currentReading(request);
  return Response.json(body, { status, headers: requestHeaders(request) });
}

/**
 * Never rejects: a reading that fails is the answer that the database is
 * unavailable, or that its state is unknown where it only ran out of time.
 */
async function read(request: Request): Promise<Reading> {
  try {
    const [heartbeat, signalRow] = await readSignals();
    const worker = evaluateWorkerHeartbeat(heartbeat);
    const signals = evaluateOperationalSignals(
      signalRow ?? {
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
    return {
      status: healthy ? 200 : 503,
      body: {
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
    };
  } catch (error) {
    const timedOut = TIMED_OUT.has(String((error as { code?: unknown }).code));
    logServerError(request, "health_check_failed", error, {
      status_code: 503,
      error_code: timedOut ? "database_timeout" : "database_unavailable",
    });
    return timedOut ? databaseUnknown() : notReady("unavailable");
  }
}

export const loader = methods({ GET: health });
export const action = loader;
