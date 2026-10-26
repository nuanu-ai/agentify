import { canonicalCheckLabel } from "./canonical-copy.js";

/**
 * What a prompt's reader is told of the scan behind it, since the prompt may be
 * all they have: when the site was inspected, how much of it the scan could
 * assess, and the label codes of the checks it could not.
 */
export type ScanAssessment = Readonly<{
  inspectedAt: string;
  coverage: number;
  unassessed: readonly string[];
}>;

/**
 * The assessment of a scan as its report gives it, or as its status does with
 * its time and coverage put in the report's terms: a check is unassessed when
 * it is unavailable.
 */
export function assessmentOf(scan: {
  scanned_at: string;
  coverage: number;
  checks: readonly { status: string; label_code: string }[];
}): ScanAssessment {
  return {
    inspectedAt: scan.scanned_at,
    coverage: scan.coverage,
    unassessed: scan.checks
      .filter((check) => check.status === "unavailable")
      .map((check) => check.label_code),
  };
}

/**
 * A share from 0 to 1 as the whole percent it has reached, rounded down. A
 * figure shown beside a verdict decided on the share then never shows a line
 * the share has not reached: 0.698 is 69%, under the 70% below which a result
 * is provisional, and only a whole share is 100%.
 */
export const percentReached = (share: number): string =>
  // The small addition keeps 0.29, which floating point holds as
  // 28.999999999999996 percent, at 29%.
  `${Math.floor(share * 100 + 1e-9)}%`;

const inspectedLabel = (moment: string): string => {
  const at = new Date(moment);
  if (Number.isNaN(at.getTime())) return "time not recorded";
  return `${at.toISOString().slice(0, 10)} ${at.toISOString().slice(11, 16)} UTC`;
};

/** The lines that say when, how much, and what is unknown, one fact to a line. */
export function assessmentLines(assessment: ScanAssessment): string[] {
  const unknown = assessment.unassessed.map(canonicalCheckLabel);
  return [
    `Inspected: ${inspectedLabel(assessment.inspectedAt)}`,
    `Coverage: ${percentReached(assessment.coverage)} of the applicable checks, by weight, could be assessed.`,
    unknown.length
      ? `Not assessed: ${unknown.join(", ")}. Whether these pass is unknown; they are not failures, and nothing here asks for a change to them.`
      : "Not assessed: none. Every applicable check was assessed.",
  ];
}
