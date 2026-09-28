import type { RobotsReason } from "@agentify/scanner-contracts";

import { robotsNotices } from "../lib/robots-notice";

const checkCount = (count: number) => (count === 1 ? "1 check was" : `${count} checks were`);

const COPY: Record<RobotsReason, (count: number) => string> = {
  disallowed: (count) =>
    `Your robots.txt keeps the Agentify scanner out, and the scanner follows it, so ${checkCount(count)} not assessed. They lower coverage, not your score. To have them assessed, allow the agentify-scanner user agent in robots.txt.`,
  unassessed: (count) =>
    `The scanner could not read your robots.txt, or could not decide its rules for these addresses, so it read nothing robots.txt might forbid: ${checkCount(count)} not assessed. They lower coverage, not your score.`,
};

// Tells the owner which checks their robots.txt kept the scanner from, and
// why, so a scan it stopped does not read as a scanner fault.
export function RobotsNotice({
  checks,
  className,
}: Readonly<{
  checks: readonly Readonly<{ id: number; robots: RobotsReason | null }>[];
  className?: string;
}>) {
  return robotsNotices(checks).map(({ reason, checkIds }) => (
    <p className={className} data-robots-notice={reason} key={reason}>
      {COPY[reason](checkIds.length)}
    </p>
  ));
}
