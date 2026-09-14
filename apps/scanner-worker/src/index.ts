import {
  createLogger,
  safeErrorCode,
  safeErrorType,
} from "@agentify/observability";

import { readWorkerEnv } from "./env.js";
import { startHealthServer, type WorkerHealth } from "./health.js";
import { startWorkerInfrastructure } from "./infrastructure.js";

const env = readWorkerEnv();
const logger = createLogger({
  service: "scanner-worker",
  environment: env.ANALYTICS_ENV,
});
process.once("uncaughtException", (error) => {
  logger.error("worker_uncaught_exception", {
    worker_id: env.WORKER_ID,
    error_type: safeErrorType(error),
    error_code: safeErrorCode(error),
  });
  process.exit(1);
});
process.once("unhandledRejection", (error) => {
  logger.error("worker_unhandled_rejection", {
    worker_id: env.WORKER_ID,
    error_type: safeErrorType(error),
    error_code: safeErrorCode(error),
  });
  process.exit(1);
});
logger.info("worker_process_starting", {
  worker_id: env.WORKER_ID,
});
const health: WorkerHealth = {
  live: true,
  ready: false,
  queueConnected: false,
  databaseConnected: false,
  configuredConcurrency: env.SCANNER_CONCURRENCY,
  lastHeartbeatAt: null,
};
const healthServer = startHealthServer(env.WORKER_HEALTH_PORT, health);

try {
  const stopInfrastructure = await startWorkerInfrastructure(
    env,
    health,
    logger,
  );
  const shutdown = async () => {
    logger.info("worker_process_shutdown_requested", {
      worker_id: env.WORKER_ID,
    });
    health.live = false;
    await stopInfrastructure();
    healthServer.close(() => process.exit(0));
  };
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
} catch (error) {
  health.ready = false;
  logger.error("worker_startup_failed", {
    worker_id: env.WORKER_ID,
    error_type: safeErrorType(error),
    error_code: safeErrorCode(error),
  });
  process.exitCode = 1;
  healthServer.close();
}
