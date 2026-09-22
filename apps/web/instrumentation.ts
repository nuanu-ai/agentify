import {
  classifyHttpRoute,
  createLogger,
  safeErrorCode,
  safeErrorType,
} from "@agentify/observability";
import type { Instrumentation } from "next";

const logger = createLogger({
  service: "web",
  environment: process.env.NODE_ENV ?? "development",
});

const DELETION_RETRY_INTERVAL_MS = 30_000;
const scannerInstrumentation = globalThis as typeof globalThis & {
  scannerDeletionRetryStarted?: boolean;
};

export async function register() {
  if (
    process.env.NEXT_RUNTIME !== "nodejs" ||
    scannerInstrumentation.scannerDeletionRetryStarted ||
    !process.env.CABINET_IDENTITY_URL ||
    !process.env.REPORT_IDENTITY_SECRET
  ) {
    return;
  }
  scannerInstrumentation.scannerDeletionRetryStarted = true;
  const { retryPendingScannerIdentityDeletions } = await import(
    "./lib/server/scanner-identity-deletion"
  );
  const run = () => {
    void retryPendingScannerIdentityDeletions().catch(() => undefined);
  };
  run();
  const timer = setInterval(run, DELETION_RETRY_INTERVAL_MS);
  timer.unref();
}

export const onRequestError: Instrumentation.onRequestError = (error, request) => {
  const rawRequestId = request.headers["x-request-id"];
  const requestId = Array.isArray(rawRequestId) ? rawRequestId[0] : rawRequestId;
  logger.error("web_unhandled_request_error", {
    request_id: requestId,
    route: classifyHttpRoute(request.path.split("?", 1)[0] ?? "/"),
    method: request.method,
    error_type: safeErrorType(error),
    error_code: safeErrorCode(error),
  });
};
