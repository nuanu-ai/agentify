import type { PublicShareSnapshot } from "@agentify/scanner-contracts";

export type ShareTone = "critical" | "warning" | "neutral" | "positive";

export type ShareCopy = {
  kicker: string;
  headline: string;
  subline: string;
  tone: ShareTone;
};

function cleanHost(host: string): string {
  return host.replace(/^www\./i, "");
}

/**
 * Public-safe copy for the immutable share/social preview. It describes the
 * measured HTTP baseline without claiming a model answer or verified action.
 */
export function shareCopy(snapshot: PublicShareSnapshot): ShareCopy {
  const host = cleanHost(snapshot.host);
  const score = snapshot.score;

  switch (snapshot.level) {
    case "invisible":
      return {
        tone: "critical",
        kicker: "Limited public signals",
        headline: `${host} has major agent-readiness gaps`,
        subline: `${score}/100 — public HTTP diagnostic, not a model-visibility test.`,
      };
    case "readable":
      return {
        tone: "warning",
        kicker: "Readable baseline",
        headline: `${host} exposes some agent-readable signals`,
        subline: `${score}/100 — useful foundations are present, with material gaps.`,
      };
    case "callable_ready":
      return {
        tone: "neutral",
        kicker: "Callable metadata-ready",
        headline: `${host} exposes strong agent-readable foundations`,
        subline: `${score}/100 — discovery metadata is strong; tool execution was not tested.`,
      };
    case "ahead_of_market":
      return {
        tone: "positive",
        kicker: "Ahead of the market",
        headline: `${host} has a strong public agent-readiness baseline`,
        subline: `${score}/100 — a public HTTP diagnostic, not a certification.`,
      };
    case "incomplete":
    default:
      return {
        tone: "neutral",
        kicker: "Inconclusive",
        headline: `We couldn't fully read ${host}`,
        subline: "Coverage was too low for a confident score.",
      };
  }
}
