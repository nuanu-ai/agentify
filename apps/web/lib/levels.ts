import type { DiagnosticLevel } from "@agentify/scanner-contracts";

/** A diagnostic level in the words every page names it by. */
export const LEVEL_LABELS: Readonly<Record<DiagnosticLevel, string>> = {
  invisible: "Invisible",
  readable: "Readable",
  callable_ready: "Callable-ready",
  ahead_of_market: "Ahead of the market",
  incomplete: "Incomplete",
};

/**
 * Below this coverage a result is provisional, whatever its level says; the
 * methodology names the same line.
 */
export const PROVISIONAL_BELOW = 0.7;

const SCAN_DAY = new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeZone: "UTC" });

/**
 * The day a scan finished, in UTC, as its public link names it; null for a
 * moment that is no date, which then names no day rather than a wrong one.
 */
export const scanDay = (moment: string): string | null => {
  const at = new Date(moment);
  return Number.isNaN(at.getTime()) ? null : SCAN_DAY.format(at);
};
