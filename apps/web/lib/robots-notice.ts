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

type AssessedCheck = Readonly<{ id: number; status: string; robots: RobotsReason | null }>;

// The unavailable checks robots.txt does not explain: a timeout, a block, a
// robots.txt that was itself never read.
export const unexplainedUnavailable = (checks: readonly AssessedCheck[]): number[] =>
  checks
    .filter((check) => check.status === "unavailable" && check.robots === null)
    .map(({ id }) => id);

// Whether a scan's headline may name robots.txt as the reason it produced no
// result: only when every unavailable check is robots.txt's doing.
export const robotsHeadline = (checks: readonly AssessedCheck[]): RobotsReason | null => {
  const notices = robotsNotices(checks);
  if (!notices.length || unexplainedUnavailable(checks).length) return null;
  return notices.every(({ reason }) => reason === "disallowed") ? "disallowed" : "unassessed";
};
