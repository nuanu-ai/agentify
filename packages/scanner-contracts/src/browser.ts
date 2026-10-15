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
