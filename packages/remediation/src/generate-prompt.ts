import type { BrowserObservationId } from "@agentify/scanner-contracts";
import {
  canonicalCheckLabel,
  canonicalFixCopy,
  canonicalImpactCopy,
  canonicalSummaryCopy,
} from "./canonical-copy.js";
import { BROWSER_REMEDIATION_CATALOG } from "./catalog/browser-observations.js";
import { HTTP_CHECK_CATALOG } from "./catalog/http-checks.js";
import { type SafeEvidence, safeCode, sanitizeEvidence } from "./sanitize.js";

export type RemediationFindingInput = {
  id: string;
  source: "canonical-http" | "browser-observation";
  status: "fail" | "partial";
  labelCode: string;
  summaryCode?: string | null;
  impactCode?: string | null;
  remediationCode?: string | null;
  evidence?: unknown;
};

export type GeneratedRemediationPrompt = {
  content: string;
  includedFindings: string[];
};

const titleCase = (value: string): string =>
  value
    .replaceAll("_", " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());

const evidenceLine = (evidence: SafeEvidence): string | undefined => {
  const values = Object.entries(evidence).map(
    ([key, value]) =>
      `${titleCase(key)}: ${Array.isArray(value) ? value.join(", ") : String(value)}`,
  );
  return values.length ? values.join("; ") : undefined;
};

export function generateRemediationPrompt(input: {
  scope: "teaser" | "full";
  host: string;
  findings: RemediationFindingInput[];
  platform?: string | null;
}): GeneratedRemediationPrompt {
  const host = input.host
    .toLowerCase()
    .replace(/[^a-z0-9.-]/g, "")
    .slice(0, 253);
  const findings = input.findings
    .filter(
      (finding) => finding.status === "fail" || finding.status === "partial",
    )
    .flatMap((finding) => {
      const id = safeCode(finding.id);
      const labelCode = safeCode(finding.labelCode);
      if (!id || !labelCode) return [];
      return [
        {
          ...finding,
          id,
          labelCode,
          summaryCode: safeCode(finding.summaryCode),
          impactCode: safeCode(finding.impactCode),
          remediationCode: safeCode(finding.remediationCode),
          evidence: sanitizeEvidence(finding.evidence),
        },
      ];
    });
  const includedFindings = findings.map(({ source, id }) => `${source}:${id}`);
  const blocks = findings.map((finding, index) => {
    const browser =
      finding.source === "browser-observation"
        ? BROWSER_REMEDIATION_CATALOG[finding.id as BrowserObservationId]
        : undefined;
    const http =
      finding.source === "canonical-http"
        ? HTTP_CHECK_CATALOG[finding.id]
        : undefined;
    const desired = browser?.desiredState ?? http?.desiredState;
    const verification = browser?.verification ?? http?.verification;
    const evidence = evidenceLine(finding.evidence);
    const canonical = finding.source === "canonical-http";
    return [
      `## ${index + 1}. ${canonical ? canonicalCheckLabel(finding.labelCode) : titleCase(finding.labelCode)} (${finding.status})`,
      finding.summaryCode
        ? `Finding: ${canonical ? canonicalSummaryCopy(finding.summaryCode) : titleCase(finding.summaryCode)}`
        : "",
      finding.impactCode
        ? `Why it matters: ${canonical ? canonicalImpactCopy(finding.impactCode) : titleCase(finding.impactCode)}`
        : "",
      finding.remediationCode
        ? `Recommended change: ${canonical ? canonicalFixCopy(finding.remediationCode) : titleCase(finding.remediationCode)}`
        : "",
      desired ? `Desired state: ${desired}` : "",
      evidence ? `Sanitized evidence: ${evidence}` : "",
      verification ? `Verification: ${verification}` : "",
      browser?.standard || http?.standard
        ? `Reference: ${browser?.standard ?? http?.standard}`
        : "",
    ]
      .filter(Boolean)
      .join("\n");
  });
  const content = [
    "# Agentify remediation implementation prompt",
    "",
    `Site: ${host || "public site"}`,
    `Scope: ${input.scope}`,
    "Diagnostic versions: gtm-v1.0.0 and browser-public-v1.0.0 (browser findings are non-scoring).",
    input.platform && safeCode(input.platform)
      ? `Detected platform hint: ${safeCode(input.platform)}`
      : "",
    "",
    "Implement only the evidence-backed issues below. Do not invent findings, weaken authentication/security, submit forms, add tracking, or change public contracts without tests. Preserve existing behavior outside this scope.",
    "",
    ...blocks,
    "",
    "After implementation, run formatting, lint, typecheck, unit/integration tests, browser/mobile accessibility checks, and a production-like smoke. Report each finding as fixed, intentionally deferred, or unverifiable with evidence.",
  ]
    .filter((line, index, all) => line !== "" || all[index - 1] !== "")
    .join("\n")
    .trim();
  return {
    content:
      findings.length > 0
        ? content
        : `${content}\n\nNo fail or partial findings are currently available to fix.`,
    includedFindings,
  };
}
