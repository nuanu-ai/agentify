import {
  classifyHttpRoute,
  createLogger,
  safeErrorCode,
  safeErrorType,
} from "@b2a/observability";
import type { Instrumentation } from "next";

const logger = createLogger({
  service: "web",
  environment: process.env.NODE_ENV ?? "development",
});

export const onRequestError: Instrumentation.onRequestError = (
  error,
  request,
) => {
  const rawRequestId = request.headers["x-request-id"];
  const requestId = Array.isArray(rawRequestId)
    ? rawRequestId[0]
    : rawRequestId;
  logger.error("web_unhandled_request_error", {
    request_id: requestId,
    route: classifyHttpRoute(request.path.split("?", 1)[0] ?? "/"),
    method: request.method,
    error_type: safeErrorType(error),
    error_code: safeErrorCode(error),
  });
};
