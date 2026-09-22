import {
  classifyHttpRoute,
  createLogger,
  safeErrorCode,
  safeErrorType,
} from "@agentify/observability";
import { NextResponse } from "next/server";

import { getServerConfig } from "./config";

const ids = new WeakMap<Request, string>();
const safeRequestId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const logger = createLogger({
  service: "web",
  environment: process.env.NODE_ENV ?? "development",
});

export function requestId(request: Request): string {
  const existing = ids.get(request);
  if (existing) return existing;
  const provided = request.headers.get("x-request-id")?.slice(0, 100);
  const value = provided && safeRequestId.test(provided) ? provided : crypto.randomUUID();
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
        ...(retryAfter === undefined ? {} : { retry_after_seconds: retryAfter }),
        request_id: id,
      },
    },
    { status, headers: requestHeaders(request) },
  );
}

/**
 * A moment as the seconds a caller must wait, rounded up so nobody is sent
 * back before the wall has gone, and never below one.
 */
export function waitSeconds(retryAt: Date, now = new Date()): number {
  return Math.max(1, Math.ceil((retryAt.getTime() - now.getTime()) / 1000));
}

/**
 * A refusal a machine may act on by waiting, with the wait in the header.
 *
 * `Retry-After` is an instruction, not a hint: whatever reads it comes back
 * when it says to, and comes back again. So it belongs only where the number
 * is a wait that actually ends — a wall that falls at a known moment. A
 * status that may never change (a scan that failed) and a refusal that
 * waiting does not clear (a challenge) carry their number in the envelope as
 * a hint and no header, because an agent obeying a header there would poll a
 * dead thing forever. The envelope and the header are one claim about one
 * wait, so both carry the same number.
 */
export function waitResponse(
  request: Request,
  status: number,
  code: string,
  message: string,
  seconds: number,
) {
  const response = errorResponse(request, status, code, message, true, seconds);
  response.headers.set("Retry-After", String(seconds));
  return response;
}

export function hasSameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return false;
  try {
    return new URL(origin).origin === new URL(getServerConfig().appBaseUrl).origin;
  } catch {
    return false;
  }
}

export function bearerToken(request: Request): string | null {
  const authorization = request.headers.get("authorization");
  return authorization?.startsWith("Bearer ") ? authorization.slice(7) : null;
}
