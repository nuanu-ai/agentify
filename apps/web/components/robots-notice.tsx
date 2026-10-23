import type { RobotsReason } from "@agentify/scanner-contracts";
import type { ReactNode } from "react";

import { robotsNotices } from "../lib/robots-notice";
import { NoteIcon } from "./note-icon";

const checkCount = (count: number) => (count === 1 ? "1 check was" : `${count} checks were`);
const lowers = (count: number) =>
  `${count === 1 ? "It lowers" : "They lower"} coverage, not your score.`;

const COPY: Record<RobotsReason, (count: number) => string> = {
  disallowed: (count) =>
    `Your robots.txt keeps the Agentify scanner out of what ${count === 1 ? "1 check reads" : `${count} checks read`}, and the scanner follows it, so ${count === 1 ? "it was" : "they were"} not assessed. ${lowers(count)} To have ${count === 1 ? "it" : "them"} assessed, allow the agentify-scanner user agent in robots.txt.`,
  unassessed: (count) =>
    `The scanner could not read your robots.txt, or could not decide its rules for these addresses, so it read nothing robots.txt might forbid: ${checkCount(count)} not assessed. ${lowers(count)}`,
};

// Tells the owner which checks their robots.txt kept the scanner from, and
// why, so a scan it stopped does not read as a scanner fault: one note, a
// sentence for each reason, then whatever else `children` says of the
// coverage.
export function RobotsNotice({
  checks,
  children,
  className,
}: Readonly<{
  checks: readonly Readonly<{ id: number; robots: RobotsReason | null }>[];
  children?: ReactNode;
  className?: string;
}>) {
  const notices = robotsNotices(checks);
  if (!notices.length && !children) return null;
  return (
    <div className={className}>
      <NoteIcon />
      <div>
        {notices.map(({ reason, checkIds }) => (
          <p data-robots-notice={reason} key={reason}>
            {COPY[reason](checkIds.length)}{" "}
            <a href="/docs/scanner#robots">How the scanner reads robots.txt</a>
          </p>
        ))}
        {children}
      </div>
    </div>
  );
}
