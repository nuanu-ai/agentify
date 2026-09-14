import {
  createBrowserObservationRepository,
  createDatabase,
  createScanJobRepository,
  normalizeNodePostgresConnectionString,
  recordWorkerHeartbeat,
} from "@b2a/db";
import {
  createLogger,
  safeErrorCode,
  safeErrorType,
  type StructuredLogger,
} from "@b2a/observability";
import { PgBoss } from "pg-boss";

import type { WorkerEnv } from "./env.js";
import type { WorkerHealth } from "./health.js";
import { ApifyBrowserProviderClient } from "./apify-browser-client.js";
import { startBrowserObservationJanitor } from "./browser-observation-janitor.js";
import {
  AnalyticsOutboxRepository,
  createDestinationDeliverer,
  createPartnerRateLimitedDeliverer,
  startAnalyticsOutboxConsumer,
  type AdvisoryLockPool,
  type SqlPool,
} from "./analytics-outbox.js";
import { NodePinnedTransport, systemDnsResolver } from "./safe-fetch.js";
import { registerBrowserObservationWorker } from "./browser-observation-job.js";
import { startBrowserObservationReconciler } from "./browser-observation-reconciler.js";
import { registerScanWorker, type ScanBoss } from "./scan-job.js";
import { ScanRunner } from "./scan-runner.js";
import {
  refreshWorkerReadiness,
  type WorkerReadinessSnapshot,
} from "./readiness.js";

type WorkerMetric = {
  name: string;
  value: number;
  code?: string;
  status?: string;
  destination?: string;
  scanId?: string;
  attemptNo?: number;
};

const emitWorkerMetric = (
  logger: StructuredLogger,
  metric: WorkerMetric,
): void => {
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

  let lastQueueErrorAt = 0;
  let suppressedQueueErrors = 0;
  const logQueueError = (error: unknown) => {
    health.queueConnected = false;
    health.ready = false;
    const now = Date.now();
    if (now - lastQueueErrorAt < 60_000) {
      suppressedQueueErrors += 1;
      return;
    }
    logger.error("worker_queue_error", {
      error_type: safeErrorType(error),
      error_code: safeErrorCode(error),
      ...(suppressedQueueErrors
        ? { suppressed_count: suppressedQueueErrors }
        : {}),
    });
    lastQueueErrorAt = now;
    suppressedQueueErrors = 0;
  };

  let lastDatabaseErrorAt = 0;
  let suppressedDatabaseErrors = 0;
  const logDatabaseError = (error: unknown) => {
    health.databaseConnected = false;
    health.ready = false;
    const now = Date.now();
    if (now - lastDatabaseErrorAt < 60_000) {
      suppressedDatabaseErrors += 1;
      return;
    }
    logger.error("worker_database_error", {
      error_type: safeErrorType(error),
      error_code: safeErrorCode(error),
      ...(suppressedDatabaseErrors
        ? { suppressed_count: suppressedDatabaseErrors }
        : {}),
    });
    lastDatabaseErrorAt = now;
    suppressedDatabaseErrors = 0;
  };
  pool.on("error", logDatabaseError);

  const boss = new PgBoss({
    connectionString: normalizeNodePostgresConnectionString(env.DATABASE_URL),
    schema: "pgboss",
    application_name: "agentify-scanner-worker",
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
  const browserActive =
    env.APIFY_BROWSER_ENABLED && env.APIFY_BROWSER_MODE !== "off";
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
        logger.error(
          "browser_observation_budget_exceeded_after_reconciliation",
          {
            observation_id: observationId,
            usage_usd: dayTotalUsd,
          },
        );
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
      cacheEnabled: env.SCANNER_CACHE_ENABLED,
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
  const stopAnalyticsConsumer =
    env.POSTHOG_ENABLED || env.META_CAPI_ENABLED
      ? startAnalyticsOutboxConsumer({
          repository: new AnalyticsOutboxRepository(
            pool as unknown as SqlPool,
            [
              ...(env.POSTHOG_ENABLED ? (["posthog"] as const) : []),
              ...(env.META_CAPI_ENABLED ? (["meta"] as const) : []),
            ],
          ),
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
        })
      : () => {};
  const stopPartnerConsumer = env.PARTNER_POSTBACK_ENABLED
    ? startAnalyticsOutboxConsumer({
        repository: new AnalyticsOutboxRepository(pool as unknown as SqlPool, [
          "partner_tracker",
        ]),
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
            browser_observation_mode: browserActive
              ? env.APIFY_BROWSER_MODE
              : "off",
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
