import {
  createLogger,
  type StructuredLogger,
  safeErrorCode,
  safeErrorType,
} from "@agentify/observability";
import {
  createBrowserObservationRepository,
  createDatabase,
  createScanJobRepository,
  normalizeNodePostgresConnectionString,
  recordWorkerHeartbeat,
} from "@agentify/scanner-database";
import { PgBoss } from "pg-boss";
import {
  type AdvisoryLockPool,
  AnalyticsOutboxRepository,
  createDestinationDeliverer,
  createPartnerRateLimitedDeliverer,
  type SqlPool,
  startAnalyticsOutboxConsumer,
} from "./analytics-outbox.js";
import { ApifyBrowserProviderClient } from "./apify-browser-client.js";
import { startBrowserObservationJanitor } from "./browser-observation-janitor.js";
import { registerBrowserObservationWorker } from "./browser-observation-job.js";
import { startBrowserObservationReconciler } from "./browser-observation-reconciler.js";
import type { WorkerEnv } from "./env.js";
import type { WorkerHealth } from "./health.js";
import { startLostScanSweeper } from "./lost-scan-sweeper.js";
import { refreshWorkerReadiness, type WorkerReadinessSnapshot } from "./readiness.js";
import { NodePinnedTransport, systemDnsResolver } from "./safe-fetch.js";
import { registerScanWorker, type ScanBoss } from "./scan-job.js";
import { ScanRunner } from "./scan-runner.js";

type WorkerMetric = {
  name: string;
  value: number;
  code?: string;
  status?: string;
  destination?: string;
  scanId?: string;
  attemptNo?: number;
};

const emitWorkerMetric = (logger: StructuredLogger, metric: WorkerMetric): void => {
  const attributes = {
    metric: metric.name,
    value: metric.value,
    ...(metric.code ? { error_code: metric.code } : {}),
    ...(metric.status ? { status: metric.status } : {}),
    ...(metric.destination ? { destination: metric.destination } : {}),
    ...(metric.scanId ? { scan_id: metric.scanId } : {}),
    ...(metric.attemptNo ? { attempt_no: metric.attemptNo } : {}),
  };
  if (/failure|failed|dead_letter|unknown|exceeded/.test(metric.name))
    logger.warn("worker_metric", attributes);
  else logger.info("worker_metric", attributes);
};

// A failure repeated every second while a dependency is down is logged once
// a minute, with the count of those left out.
const throttledErrorLog = (
  logger: StructuredLogger,
  event: string,
  onEach: () => void = () => {},
): ((error: unknown) => void) => {
  let lastLoggedAt = 0;
  let suppressed = 0;
  return (error) => {
    onEach();
    const now = Date.now();
    if (now - lastLoggedAt < 60_000) {
      suppressed += 1;
      return;
    }
    logger.error(event, {
      error_type: safeErrorType(error),
      error_code: safeErrorCode(error),
      ...(suppressed ? { suppressed_count: suppressed } : {}),
    });
    lastLoggedAt = now;
    suppressed = 0;
  };
};

export async function startWorkerInfrastructure(
  env: WorkerEnv,
  health: WorkerHealth,
  logger: StructuredLogger = createLogger({
    service: "scanner-worker",
    environment: env.ANALYTICS_ENV,
  }),
) {
  const startedAt = new Date();
  logger.info("worker_infrastructure_starting", {
    worker_id: env.WORKER_ID,
    configured_concurrency: env.SCANNER_CONCURRENCY,
    browser_mode: env.APIFY_BROWSER_MODE,
  });
  const { db, pool } = createDatabase(env.DATABASE_URL);
  await pool.query("select 1");
  health.databaseConnected = true;

  const logQueueError = throttledErrorLog(logger, "worker_queue_error", () => {
    health.queueConnected = false;
    health.ready = false;
  });
  const logDatabaseError = throttledErrorLog(logger, "worker_database_error", () => {
    health.databaseConnected = false;
    health.ready = false;
  });
  pool.on("error", logDatabaseError);

  // The one `pgboss` schema the gateway's queue uses too (queue-schema.test.ts).
  // The gateway's nightly schedules are its own to send, so this client sends
  // none.
  const boss = new PgBoss({
    connectionString: normalizeNodePostgresConnectionString(env.DATABASE_URL),
    schema: "pgboss",
    application_name: "agentify-scanner-worker",
    schedule: false,
  });
  boss.on("error", logQueueError);
  boss.on("warning", (warning) => {
    logger.warn("worker_queue_warning", {
      error_type: safeErrorType(warning),
    });
  });
  await boss.start();
  health.queueConnected = true;
  await boss.createQueue("scan-v1", {
    retryLimit: 1,
    retryDelay: 1,
    expireInSeconds: 60,
  });
  const repository = createScanJobRepository(db);
  const browserActive = env.APIFY_BROWSER_ENABLED && env.APIFY_BROWSER_MODE !== "off";
  const browserRepository = createBrowserObservationRepository(db);
  const enqueueBrowserObservation = async (job: {
    observation_id: string;
    operation_id: string;
    attempt_no: 1;
  }) => {
    await boss.send("browser-observation-v1", job, {
      singletonKey: job.observation_id,
    });
  };
  let stopBrowserReconciler = () => {};
  let stopBrowserJanitor = () => {};
  if (browserActive) {
    const browserProvider = new ApifyBrowserProviderClient(env.APIFY_API_TOKEN);
    await boss.createQueue("browser-observation-v1", {
      retryLimit: 0,
      expireInSeconds: env.APIFY_BROWSER_TIMEOUT_SECONDS + 30,
    });
    await registerBrowserObservationWorker(
      boss,
      {
        repository: browserRepository,
        provider: browserProvider,
        config: {
          timeoutSeconds: env.APIFY_BROWSER_TIMEOUT_SECONDS,
          maxRunUsd: env.APIFY_BROWSER_MAX_RUN_USD,
          dailyBudgetUsd: env.APIFY_BROWSER_DAILY_BUDGET_USD,
          maxPages: env.APIFY_BROWSER_MAX_PAGES,
        },
        emitMetric: (metric) => emitWorkerMetric(logger, metric),
      },
      env.APIFY_BROWSER_CONCURRENCY,
    );
    stopBrowserReconciler = startBrowserObservationReconciler({
      repository: browserRepository,
      enqueue: enqueueBrowserObservation,
      onError: (error) => {
        logger.error("browser_observation_reconciler_failed", {
          error_type: safeErrorType(error),
        });
      },
    });
    stopBrowserJanitor = startBrowserObservationJanitor({
      repository: browserRepository,
      provider: browserProvider,
      dailyBudgetUsd: env.APIFY_BROWSER_DAILY_BUDGET_USD,
      onUsageError: (observationId) => {
        logger.error("browser_observation_usage_reconciliation_failed", {
          observation_id: observationId,
        });
      },
      onBudgetExceeded: (observationId, dayTotalUsd) => {
        logger.error("browser_observation_budget_exceeded_after_reconciliation", {
          observation_id: observationId,
          usage_usd: dayTotalUsd,
        });
      },
      onCleanupError: (observationId) => {
        logger.error("browser_observation_cleanup_failed", {
          observation_id: observationId,
        });
      },
      onError: (error) => {
        logger.error("browser_observation_janitor_failed", {
          error_type: safeErrorType(error),
        });
      },
    });
  }
  await registerScanWorker(
    boss as unknown as ScanBoss,
    {
      repository,
      runner: new ScanRunner({
        resolver: systemDnsResolver,
        transport: new NodePinnedTransport(),
        appBaseUrl: env.APP_BASE_URL,
      }),
      emitMetric: (metric) => emitWorkerMetric(logger, metric),
      ...(browserActive
        ? {
            browserObservation: {
              actorId: env.APIFY_BROWSER_ACTOR_ID,
              actorBuild: env.APIFY_BROWSER_ACTOR_BUILD,
              sampleRate: env.APIFY_BROWSER_SAMPLE_RATE,
              enqueue: enqueueBrowserObservation,
            },
          }
        : {}),
    },
    env.SCANNER_CONCURRENCY,
  );
  const stopLostScanSweeper = startLostScanSweeper({
    finishLostScans: (lostAfterMs) => repository.finishLostScans(lostAfterMs),
    onFinished: (scanIds) => {
      for (const scanId of scanIds) logger.warn("scan_lost", { scan_id: scanId });
    },
    onError: (error) => {
      logger.error("lost_scan_sweep_failed", { error_type: safeErrorType(error) });
    },
  });
  const stopAnalyticsConsumer =
    env.POSTHOG_ENABLED || env.META_CAPI_ENABLED
      ? startAnalyticsOutboxConsumer({
          repository: new AnalyticsOutboxRepository(pool as unknown as SqlPool, [
            ...(env.POSTHOG_ENABLED ? (["posthog"] as const) : []),
            ...(env.META_CAPI_ENABLED ? (["meta"] as const) : []),
          ]),
          deliver: createDestinationDeliverer({
            runtimeEnvironment: env.ANALYTICS_ENV,
            posthog: {
              destinationEnvironment: env.POSTHOG_DESTINATION_ENV,
              host: env.POSTHOG_HOST,
              enabled: env.POSTHOG_ENABLED,
            },
            meta: {
              destinationEnvironment: env.META_DESTINATION_ENV,
              graphBaseUrl: env.META_GRAPH_BASE_URL,
              apiVersion: env.META_API_VERSION,
              datasetId: env.META_DATASET_ID,
              accessToken: env.META_ACCESS_TOKEN,
              enabled: env.META_CAPI_ENABLED,
            },
          }),
          emitMetric: (metric) => emitWorkerMetric(logger, metric),
          onError: throttledErrorLog(logger, "analytics_outbox_cycle_failed"),
        })
      : () => {};
  const stopPartnerConsumer = env.PARTNER_POSTBACK_ENABLED
    ? startAnalyticsOutboxConsumer({
        repository: new AnalyticsOutboxRepository(pool as unknown as SqlPool, ["partner_tracker"]),
        deliver: createPartnerRateLimitedDeliverer(
          pool as unknown as AdvisoryLockPool,
          createDestinationDeliverer({
            runtimeEnvironment: env.ANALYTICS_ENV,
            partner: {
              destinationEnvironment: "production",
              enabled: true,
              secret: env.PARTNER_POSTBACK_SECRET,
            },
          }),
        ),
        claimLimit: 1,
        intervalMs: 1_100,
        emitMetric: (metric) => emitWorkerMetric(logger, metric),
        onError: throttledErrorLog(logger, "partner_outbox_cycle_failed"),
      })
    : () => {};

  let lastReadiness = "";
  const logReadinessTransition = (snapshot: WorkerReadinessSnapshot) => {
    const signature = `${snapshot.ready}:${snapshot.databaseConnected}:${snapshot.queueConnected}`;
    if (signature === lastReadiness) return;
    lastReadiness = signature;
    const attributes = {
      ready: snapshot.ready,
      database_connected: snapshot.databaseConnected,
      queue_connected: snapshot.queueConnected,
      configured_concurrency: env.SCANNER_CONCURRENCY,
      worker_id: env.WORKER_ID,
    };
    if (snapshot.ready) logger.info("worker_readiness_changed", attributes);
    else logger.warn("worker_readiness_changed", attributes);
  };

  const heartbeat = async () => {
    const snapshot = await refreshWorkerReadiness({
      health,
      probeDatabase: async () => {
        await pool.query("select 1");
        return true;
      },
      probeQueue: async () => (await boss.getQueue("scan-v1")) !== null,
      writeHeartbeat: async (readiness) => {
        await recordWorkerHeartbeat(db, {
          workerId: env.WORKER_ID,
          service: "scanner-worker",
          startedAt,
          metadata: {
            queue: "pg-boss",
            ready: readiness.ready,
            queue_connected: readiness.queueConnected,
            database_connected: readiness.databaseConnected,
            configured_concurrency: env.SCANNER_CONCURRENCY,
            browser_observation_mode: browserActive ? env.APIFY_BROWSER_MODE : "off",
          },
        });
      },
      onDatabaseError: logDatabaseError,
      onQueueError: logQueueError,
    });
    logReadinessTransition(snapshot);
  };

  await heartbeat();
  const heartbeatTimer = setInterval(() => {
    void heartbeat().catch((error) => {
      logDatabaseError(error);
      logReadinessTransition({
        ready: false,
        databaseConnected: health.databaseConnected,
        queueConnected: health.queueConnected,
      });
    });
  }, 10_000);
  heartbeatTimer.unref();

  logger.info("worker_infrastructure_started", {
    worker_id: env.WORKER_ID,
    ready: health.ready,
  });

  return async () => {
    logger.info("worker_infrastructure_stopping", {
      worker_id: env.WORKER_ID,
    });
    clearInterval(heartbeatTimer);
    stopBrowserReconciler();
    stopBrowserJanitor();
    stopLostScanSweeper();
    stopAnalyticsConsumer();
    stopPartnerConsumer();
    health.ready = false;
    await boss.stop({ graceful: true, timeout: 10_000 });
    await pool.end();
    logger.info("worker_infrastructure_stopped", {
      worker_id: env.WORKER_ID,
    });
  };
}
