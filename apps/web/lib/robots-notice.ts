import type { RobotsReason } from "@agentify/scanner-contracts";

// The scanner's error codes for a check robots.txt kept from being assessed.
export const robotsReasonFor = (errorCode: string | null | undefined): RobotsReason | null =>
  errorCode === "robots_disallowed"
    ? "disallowed"
    : errorCode === "robots_unavailable"
      ? "unassessed"
      : null;

export type RobotsNotice = Readonly<{ reason: RobotsReason; checkIds: number[] }>;

export const robotsNotices = (
  checks: readonly Readonly<{ id: number; robots: RobotsReason | null }>[],
): RobotsNotice[] =>
  (["disallowed", "unassessed"] as const).flatMap((reason) => {
    const checkIds = checks.filter((check) => check.robots === reason).map((check) => check.id);
    return checkIds.length ? [{ reason, checkIds }] : [];
  });
