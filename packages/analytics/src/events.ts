import {
  ANALYTICS_EVENT_NAMES,
  type AnalyticsEventName,
  type Segment,
} from "@agentify/scanner-contracts";

export type AnalyticsScalar = string | number | boolean;
export type AnalyticsProperties = Record<string, AnalyticsScalar>;

const PROPERTY_ALLOWLIST: Record<AnalyticsEventName, ReadonlySet<string>> = {
  landing_view: new Set(["day", "device", "country"]),
  scan_started: new Set(["challenge_used"]),
  scan_completed: new Set(["cache_hit", "coverage", "terminal_status"]),
  results_viewed: new Set(["coverage_band"]),
  registration_started: new Set([]),
  registration_completed: new Set(["role"]),
  card_attached: new Set(["card_signal_version"]),
  result_shared: new Set(["share_method"]),
};

const FORBIDDEN_KEY =
  /(?:email|url|uri|host|domain|query|pain|answer|free.?text|name|token|secret|ip|user.?agent|fbp|fbc)/i;
const EMAIL_OR_URL =
  /(?:https?:\/\/|www\.|[\w.+-]+@[\w.-]+\.[a-z]{2,}|\?[^\s=]+=)/i;

export type AnalyticsEvent = {
  eventId: string;
  name: AnalyticsEventName;
  occurredAt: string;
  pseudonymousId: string;
  segment: Segment;
  landingVariant: string;
  properties: AnalyticsProperties;
};

export const sanitizeEventProperties = (
  name: AnalyticsEventName,
  properties: Readonly<Record<string, unknown>>,
): AnalyticsProperties => {
  const output: AnalyticsProperties = {};
  for (const [key, value] of Object.entries(properties)) {
    if (!PROPERTY_ALLOWLIST[name].has(key) || FORBIDDEN_KEY.test(key)) continue;
    if (!["string", "number", "boolean"].includes(typeof value)) continue;
    if (
      typeof value === "string" &&
      (value.length > 80 || EMAIL_OR_URL.test(value))
    )
      continue;
    output[key] = value as AnalyticsScalar;
  }
  return output;
};

export const createAnalyticsEvent = (
  input: Omit<AnalyticsEvent, "properties"> & {
    properties?: Readonly<Record<string, unknown>>;
  },
): AnalyticsEvent => {
  if (!ANALYTICS_EVENT_NAMES.includes(input.name))
    throw new Error("event_not_allowlisted");
  if (!/^[0-9a-f-]{36}$/i.test(input.eventId))
    throw new Error("event_id_invalid");
  if (!input.pseudonymousId || EMAIL_OR_URL.test(input.pseudonymousId)) {
    throw new Error("pseudonymous_id_invalid");
  }
  return {
    ...input,
    properties: sanitizeEventProperties(input.name, input.properties ?? {}),
  };
};

export const eventOnceKey = (
  name: AnalyticsEventName,
  identifiers: Readonly<Record<string, string>>,
): string => {
  const required: Record<AnalyticsEventName, string[]> = {
    landing_view: ["session_id", "variant", "day"],
    scan_started: ["scan_id"],
    scan_completed: ["scan_id"],
    results_viewed: ["session_id", "scan_id"],
    registration_started: ["session_id", "scan_id"],
    registration_completed: ["lead_id", "scan_id"],
    card_attached: ["setup_intent_id"],
    result_shared: ["share_id"],
  };
  const fields = required[name];
  if (fields.some((field) => !identifiers[field]))
    throw new Error("event_once_key_incomplete");
  return `${name}:${fields.map((field) => identifiers[field]).join(":")}`;
};
