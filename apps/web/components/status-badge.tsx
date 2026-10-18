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

export function StatusBadge({ status }: Readonly<{ status: BadgeStatus }>) {
  const [label, tone] = STATES[status];
  return <Badge tone={tone}>{label}</Badge>;
}
