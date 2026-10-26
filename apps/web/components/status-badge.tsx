import type { CheckStatus } from "@agentify/scanner-contracts";
import { Badge, type BadgeTone } from "@agentify/ui";

type BadgeStatus = CheckStatus | "complete";

/** Each state's own word: an unavailable check is never said to have failed. */
const STATES: Record<BadgeStatus, readonly [label: string, tone: BadgeTone]> = {
  pending: ["Pending", "quiet"],
  running: ["Checking", "progress"],
  pass: ["Pass", "pass"],
  partial: ["Partial", "partial"],
  fail: ["Fail", "fail"],
  unavailable: ["Unavailable", "quiet"],
  not_applicable: ["Not applicable", "quiet"],
  complete: ["Complete", "pass"],
};

/** A state's badge; given a count, it says how many are in that state. */
export function StatusBadge({ count, status }: Readonly<{ count?: number; status: BadgeStatus }>) {
  const [label, tone] = STATES[status];
  if (count === undefined) return <Badge tone={tone}>{label}</Badge>;
  return (
    <Badge tone={tone}>
      <span className="badge-count">
        {label} <b>{count}</b>
      </span>
    </Badge>
  );
}
