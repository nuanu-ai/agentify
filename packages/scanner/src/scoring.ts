import type { CheckResult } from "@agentify/scanner-contracts";
import { BASE_BLOCKED, CHECK_WEIGHTS } from "./checks.js";
import type { ScanScore } from "./model.js";

const ASSESSED = new Set(["pass", "partial", "fail"]);

export const assertRubric = (): void => {
  const sum = CHECK_WEIGHTS.reduce((total, weight) => total + weight, 0);
  if (sum !== 100) throw new Error(`rubric_nominal_weight_invalid:${sum}`);
};

export const levelForScore = (score: number, coverage: number): ScanScore["level"] => {
  if (coverage < 0.7) return "incomplete";
  if (score <= 24) return "invisible";
  if (score <= 49) return "readable";
  if (score <= 69) return "callable_ready";
  return "ahead_of_market";
};

/**
 * Whether the site answered the home page with a bot challenge or a refusal.
 * What the scan could still read around it is what the site shows a bot it
 * has turned away, not what it shows a visitor, so no verdict is given.
 */
export const baseBlocked = (checks: readonly { errorCode?: string | null }[]): boolean =>
  checks.some((check) => check.errorCode === BASE_BLOCKED);

export const scoreChecks = (checks: readonly CheckResult[]): ScanScore => {
  assertRubric();
  const nominalWeight = CHECK_WEIGHTS.reduce((total, weight) => total + weight, 0);
  const applicableWeight = checks.reduce((total, check) => total + check.applicableWeight, 0);
  const assessedWeight = checks.reduce(
    (total, check) => total + (ASSESSED.has(check.status) ? check.applicableWeight : 0),
    0,
  );
  const earnedWeight = checks.reduce((total, check) => total + check.earnedWeight, 0);
  const coverage = applicableWeight === 0 ? 0 : assessedWeight / applicableWeight;
  const calculatedScore =
    assessedWeight === 0 ? 0 : Math.round((100 * earnedWeight) / assessedWeight);
  const blocked = baseBlocked(checks);
  const withheld = blocked || coverage < 0.3;
  const score = withheld ? null : Math.max(0, Math.min(100, calculatedScore));
  return {
    rubricVersion: "gtm-v1.0.0",
    score,
    coverage,
    level: blocked ? "incomplete" : levelForScore(calculatedScore, coverage),
    terminalStatus: withheld ? "failed" : coverage < 1 ? "partial" : "completed",
    nominalWeight,
    applicableWeight,
    assessedWeight,
    earnedWeight,
  };
};
