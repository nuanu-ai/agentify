/**
 * The vocabulary a page's own script needs, with no schema library behind it:
 * importing anything from the package's main entry evaluates every schema in
 * it, and that ships the whole of zod to the browser. The schemas in the main
 * entry are built from these values, so the two cannot drift.
 */

export const SEGMENTS = ["store", "owner", "local"] as const;

export type Segment = (typeof SEGMENTS)[number];

export const isSegment = (value: unknown): value is Segment =>
  SEGMENTS.some((segment) => segment === value);

/** Where a scan stands, from the moment it is accepted to its end. */
export const SCAN_STATUSES = [
  "accepted",
  "queued",
  "running",
  "completed",
  "partial",
  "failed",
] as const;

/** Where one check stands, and what it found once it ends. */
export const CHECK_STATUSES = [
  "pending",
  "running",
  "pass",
  "partial",
  "fail",
  "unavailable",
  "not_applicable",
] as const;

export const DIAGNOSTIC_LEVELS = [
  "invisible",
  "readable",
  "callable_ready",
  "ahead_of_market",
  "incomplete",
] as const;

/**
 * Why robots.txt kept a check from being assessed: its rules disallow what the
 * check reads, or it could not be read or decided for it.
 */
export const ROBOTS_REASONS = ["disallowed", "unassessed"] as const;

/**
 * Why the scanner stopped a scan that ended without a result, where it knows:
 * no public website answers at the address or one it redirects to, a redirect
 * leads where the scanner does not follow, or the scanner did not accept the
 * site's HTTPS certificate. A name that leads to a private address and a name that does not
 * exist share one reason, so that the answer never tells which names exist on
 * the scanner's own network.
 */
export const SCAN_STOP_REASONS = [
  "no_public_site",
  "forbidden_redirect",
  "certificate_invalid",
] as const;

/**
 * A phone number as a person types it: a plus, a country code that does not
 * start with 0, and 8 to 15 digits in all, with up to two spaces, dots, dashes
 * or brackets between digits. It is written for the HTML `pattern` attribute,
 * which browsers compile with the `v` flag, and the report request's schema
 * takes a phone exactly when it matches.
 */
export const PHONE_INPUT_PATTERN = "\\+[1-9](?:[\\s\\(\\)\\.\\-]{0,2}[0-9]){7,14}";
