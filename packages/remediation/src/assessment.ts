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
    `Coverage: ${Math.round(assessment.coverage * 100)}% of the applicable checks, by weight, could be assessed.`,
    unknown.length
      ? `Not assessed: ${unknown.join(", ")}. Whether these pass is unknown; they are not failures, and nothing here asks for a change to them.`
      : "Not assessed: none. Every applicable check was assessed.",
  ];
}
