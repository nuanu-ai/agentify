import { evaluateChecks } from "./checks.js";
import { selectFindings } from "./findings.js";
import { fingerprint } from "./fingerprint.js";
import type { ScanArtifacts, ScanEvaluation } from "./model.js";
import { scoreChecks } from "./scoring.js";

export const evaluateScan = (artifacts: ScanArtifacts): ScanEvaluation => {
  const checks = evaluateChecks(artifacts);
  return {
    checks,
    score: scoreChecks(checks),
    fingerprint: fingerprint(artifacts.base),
    findings: selectFindings(artifacts.segment, checks),
  };
};
