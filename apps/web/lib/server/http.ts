import {
  classifyHttpRoute,
  createLogger,
  safeErrorCode,
  safeErrorType,
} from "@agentify/observability";
import { NextResponse } from "next/server";

import { getServerConfig } from "./config";

const ids = new WeakMap<Request, string>();
const safeRequestId =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const logger = createLogger({
  service: "web",
  environment: process.env.NODE_ENV ?? "development",
});

export function requestId(request: Request): string {
  const existing = ids.get(request);
  if (existing) return existing;
  const provided = request.headers.get("x-request-id")?.slice(0, 100);
  const value =
    provided && safeRequestId.test(provided) ? provided : crypto.randomUUID();
  ids.set(request, value);
  return value;
}

export function requestHeaders(request: Request): Record<string, string> {
  return {
    "Cache-Control": "no-store",
    "X-Request-Id": requestId(request),
  };
}

export function logServerError(
  request: Request,
  event: string,
  error: unknown,
  attributes: Record<string, unknown> = {},
): void {
  const errorCode = attributes.error_code ?? safeErrorCode(error);
  logger.error(event, {
    ...attributes,
    request_id: requestId(request),
    route: classifyHttpRoute(new URL(request.url).pathname),
    method: request.method,
    error_type: safeErrorType(error),
    error_code: errorCode,
  });
}

export function errorResponse(
  request: Request,
  status: number,
  code: string,
  message: string,
  retryable = false,
  retryAfter?: number,
) {
  const id = requestId(request);
  const attributes = {
    request_id: id,
    route: classifyHttpRoute(new URL(request.url).pathname),
    method: request.method,
    status_code: status,
    error_code: code,
    retryable,
  };
  if (status >= 500) logger.error("api_error", attributes);
  else logger.warn("api_error", attributes);

  return NextResponse.json(
    {
      error: {
        code,
        message,
        retryable,
        ...(retryAfter === undefined
          ? {}
          : { retry_after_seconds: retryAfter }),
        request_id: id,
      },
    },
    { status, headers: requestHeaders(request) },
  );
}

export function hasSameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return false;
  try {
    return (
      new URL(origin).origin === new URL(getServerConfig().appBaseUrl).origin
    );
  } catch {
    return false;
  }
}

export function bearerToken(request: Request): string | null {
  const authorization = request.headers.get("authorization");
  return authorization?.startsWith("Bearer ") ? authorization.slice(7) : null;
}
