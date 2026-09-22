export type LogLevel = "debug" | "info" | "warn" | "error";

export type LogSink = (line: string, level: LogLevel) => void;

export type StructuredLogger = {
  debug(event: string, attributes?: Record<string, unknown>): void;
  info(event: string, attributes?: Record<string, unknown>): void;
  warn(event: string, attributes?: Record<string, unknown>): void;
  error(event: string, attributes?: Record<string, unknown>): void;
};

const SCHEMA_VERSION = "agentify-log-v1";
const SAFE_KEY = /^[a-z][a-z0-9_]{0,63}$/;
const SAFE_CODE = /^[A-Za-z0-9_.:-]{1,200}$/;
const SAFE_ID = /^[A-Za-z0-9_.:-]{1,200}$/;
const SAFE_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const allowedAttributeKeys = new Set([
  "attempt_no",
  "browser_mode",
  "cache_hit",
  "configured_concurrency",
  "database_connected",
  "destination",
  "duration_ms",
  "error_code",
  "error_type",
  "event_id",
  "metric",
  "method",
  "observation_id",
  "queue",
  "queue_connected",
  "ready",
  "request_id",
  "retryable",
  "route",
  "scan_id",
  "status",
  "status_code",
  "suppressed_count",
  "usage_usd",
  "value",
  "worker_id",
]);

const uuidKeys = new Set([
  "event_id",
  "observation_id",
  "request_id",
  "scan_id",
]);

const stringValue = (key: string, value: string): string | undefined => {
  const normalized = value.slice(0, 200);
  if (uuidKeys.has(key))
    return SAFE_UUID.test(normalized) ? normalized : undefined;
  if (key === "worker_id")
    return SAFE_ID.test(normalized) ? normalized : undefined;
  return SAFE_CODE.test(normalized) ? normalized : undefined;
};

export const sanitizeLogAttributes = (
  attributes: Record<string, unknown> = {},
): Record<string, string | number | boolean | null> => {
  const sanitized: Record<string, string | number | boolean | null> = {};
  let suppressedCount = 0;

  for (const [key, value] of Object.entries(attributes)) {
    if (!SAFE_KEY.test(key) || !allowedAttributeKeys.has(key)) {
      suppressedCount += 1;
      continue;
    }
    if (value === undefined) continue;
    if (value === null || typeof value === "boolean") {
      sanitized[key] = value;
      continue;
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      sanitized[key] = value;
      continue;
    }
    if (typeof value === "string") {
      const safe = stringValue(key, value);
      if (safe !== undefined) {
        sanitized[key] = safe;
        continue;
      }
    }
    suppressedCount += 1;
  }

  if (suppressedCount > 0) sanitized.suppressed_count = suppressedCount;
  return sanitized;
};

export const safeErrorType = (error: unknown): string => {
  if (!(error instanceof Error)) return "UnknownError";
  return SAFE_CODE.test(error.name) ? error.name : "Error";
};

export const safeErrorCode = (error: unknown): string | undefined => {
  if (typeof error !== "object" || error === null) return undefined;
  const code = (error as { code?: unknown }).code;
  if (typeof code === "string" && SAFE_CODE.test(code)) return code;
  const nested = (error as { errors?: unknown }).errors;
  if (Array.isArray(nested)) {
    for (const item of nested) {
      const nestedCode = safeErrorCode(item);
      if (nestedCode) return nestedCode;
    }
  }
  return undefined;
};

const defaultSink: LogSink = (line, level) => {
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
};

export function createLogger(input: {
  service: string;
  environment: string;
  sink?: LogSink;
  now?: () => Date;
}): StructuredLogger {
  if (!SAFE_CODE.test(input.service)) throw new Error("invalid_log_service");
  if (!SAFE_CODE.test(input.environment))
    throw new Error("invalid_log_environment");
  const sink = input.sink ?? defaultSink;
  const now = input.now ?? (() => new Date());

  const write = (
    level: LogLevel,
    event: string,
    attributes?: Record<string, unknown>,
  ) => {
    const safeEvent = SAFE_CODE.test(event) ? event : "invalid_log_event";
    const record = {
      schema: SCHEMA_VERSION,
      timestamp: now().toISOString(),
      level,
      service: input.service,
      environment: input.environment,
      event: safeEvent,
      ...sanitizeLogAttributes(attributes),
    };
    sink(JSON.stringify(record), level);
  };

  return {
    debug: (event, attributes) => write("debug", event, attributes),
    info: (event, attributes) => write("info", event, attributes),
    warn: (event, attributes) => write("warn", event, attributes),
    error: (event, attributes) => write("error", event, attributes),
  };
}

const routePatterns: readonly [RegExp, string][] = [
  [/^\/(store|local)?$/, "page_landing"],
  [/^\/(methodology|privacy|scanner|terms|data-request)$/, "page_trust"],
  [/^\/admin(?:\/.*)?$/, "page_admin"],
  [/^\/scan\/pending$/, "page_scan_pending"],
  [/^\/scan\/[^/]+$/, "page_scan"],
  [/^\/report\/[^/]+$/, "page_report"],
  [/^\/s\/[^/]+$/, "page_share"],
  [/^\/auth\/callback$/, "page_auth_callback"],
  [/^\/email\/unsubscribe$/, "page_email_unsubscribe"],
  [/^\/verification\/error$/, "page_verification_error"],
  [/^\/api\/health$/, "api_health"],
  [/^\/api\/health\/live$/, "api_health_live"],
  [/^\/api\/v1\/scans$/, "api_v1_scans_create"],
  [/^\/api\/v1\/scans\/[^/]+\/status$/, "api_v1_scan_status"],
  [/^\/api\/v1\/scans\/[^/]+\/share-preview$/, "api_v1_scan_share_preview"],
  [/^\/api\/v1\/scans\/[^/]+\/share$/, "api_v1_scan_share"],
  [
    /^\/api\/v1\/scans\/[^/]+\/registrations$/,
    "api_v1_scan_registration_legacy",
  ],
  [
    /^\/api\/v1\/scans\/[^/]+\/browser-observation$/,
    "api_v1_browser_observation",
  ],
  [
    /^\/api\/v1\/scans\/[^/]+\/remediation-prompt(?:\/download)?$/,
    "api_v1_scan_remediation",
  ],
  [/^\/api\/v1\/reports\/[^/]+$/, "api_v1_report"],
  [
    /^\/api\/v1\/reports\/[^/]+\/remediation-prompt(?:\/download)?$/,
    "api_v1_report_remediation",
  ],
  [/^\/api\/v1\/shares\/[^/]+$/, "api_v1_share"],
  [/^\/api\/v1\/card-signals\/setup-intents$/, "api_v1_card_setup"],
  [
    /^\/api\/v1\/card-signals\/[^/]+(?:\/payment-method|\/local-confirm)?$/,
    "api_v1_card_signal",
  ],
  [/^\/api\/v1\/(attribution|consent|events)$/, "api_v1_analytics"],
  [/^\/api\/v1\/account\/(data-request|unsubscribe)$/, "api_v1_account"],
  [/^\/api\/v1\/auth\/verify$/, "api_v1_auth_verify"],
  [/^\/api\/v1\/webhooks\/stripe$/, "api_v1_stripe_webhook"],
  [/^\/api\/v2\/auth\/finalize$/, "api_v2_auth_finalize"],
  [
    /^\/api\/v2\/scans\/[^/]+\/(registrations|contact-access)$/,
    "api_v2_scan_contact",
  ],
  [/^\/_next\//, "asset_next"],
];

export const classifyHttpRoute = (pathname: string): string =>
  routePatterns.find(([pattern]) => pattern.test(pathname))?.[1] ?? "other";
