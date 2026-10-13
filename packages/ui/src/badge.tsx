import type { ReactNode } from "react";

/**
 * The verdicts and the notice are the colours the shared tokens name;
 * `progress` is a state not settled yet, and `quiet` one nobody has to act on.
 */
export type BadgeTone = "pass" | "partial" | "fail" | "notice" | "progress" | "quiet";

export function Badge({ tone, children }: Readonly<{ tone?: BadgeTone; children: ReactNode }>) {
  return <span className={tone === undefined ? "badge" : `badge badge-${tone}`}>{children}</span>;
}
