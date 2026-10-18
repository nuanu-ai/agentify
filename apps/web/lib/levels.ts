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

/** The day a scan finished, in UTC, as its public link names it. */
export const scanDay = (moment: string): string => SCAN_DAY.format(new Date(moment));
