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

/** Rounded up and at least one, so a caller never comes back before `retryAt`. */
export function waitSeconds(retryAt: Date, now = new Date()): number {
  return Math.max(1, Math.ceil((retryAt.getTime() - now.getTime()) / 1000));
}

/**
 * A refusal that waiting clears, with the same wait in the envelope and in
 * `Retry-After`. Use it only where the wait really ends at a known moment: a
 * client obeying the header on a failed scan or a challenge would poll forever.
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

/**
 * The answer when the outcome depends on who is asking and the dashboard did
 * not answer. "Nothing here for you" would be a claim about a visitor the
 * scanner could not identify.
 */
export function visitorUnknownResponse(request: Request) {
  return errorResponse(
    request,
    503,
    "visitor_unknown",
    "We cannot tell who is visiting right now. Try again shortly.",
    true,
    30,
  );
}

/**
 * The refusal for a press from a page loaded for another address than the one
 * signed in now, or null when they match. A page left open across a sign-out
 * and a sign-in as someone else sends the new cookie, so the page sends the
 * address it showed and a mismatch or none changes nothing. The message names
 * only the signed-in address; the other is whatever the request claimed.
 */
export function pageNotMatched(request: Request, sent: unknown, email: string) {
  const named =
    typeof sent === "object" && sent !== null
      ? (sent as { signed_in_as?: unknown }).signed_in_as
      : undefined;
  return named === email
    ? null
    : errorResponse(
        request,
        409,
        "page_not_matched",
        `The page this came from could not be matched to the address signed in now, ${email}, so nothing was changed. Reload the page to act as this address.`,
      );
}
