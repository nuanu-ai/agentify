import { generateRemediationPrompt, type RemediationFindingInput } from "@agentify/remediation";
import type {
  BrowserObservationFinding,
  RemediationPromptResponse,
} from "@agentify/scanner-contracts";
import { CHECK_DEFINITIONS } from "@agentify/scanner-contracts";
import { scanChecks, scans } from "@agentify/scanner-database";
import { eq } from "drizzle-orm";
import { getDatabase } from "./database";
import { getFullBrowserObservation, getFullReport } from "./reporting";
import { getScanStatusForVerifiedSession } from "./scans";

const CHECK_LABEL_BY_ID = new Map<number, string>(
  CHECK_DEFINITIONS.map((definition) => [definition.id, definition.labelCode]),
);

const fromBrowser = (
  findings: BrowserObservationFinding[] | undefined,
): RemediationFindingInput[] =>
  (findings ?? []).flatMap((finding) =>
    finding.status === "fail" || (finding.status === "partial" && Boolean(finding.remediation_code))
      ? [
          {
            id: finding.id,
            source: "browser-observation" as const,
            status: finding.status,
            labelCode: finding.id,
            summaryCode: finding.summary_code,
            impactCode: finding.user_impact_code,
            remediationCode: finding.remediation_code,
            evidence: finding.evidence,
          },
        ]
      : [],
  );

export async function getTeaserRemediationPrompt(
  scanId: string,
  cookieHeader: string | undefined | null,
): Promise<RemediationPromptResponse | undefined> {
  const status = await getScanStatusForVerifiedSession(scanId, cookieHeader);
  if (!status?.teaser) return undefined;
  const { db } = getDatabase();
  const scan = (await db.select().from(scans).where(eq(scans.id, scanId)).limit(1))[0];
  if (!scan) return undefined;
  const rows = await db.select().from(scanChecks).where(eq(scanChecks.scanId, scanId));
  const visibleCodes = new Set(status.teaser.top_findings);
  const canonicalFindings: RemediationFindingInput[] = rows.flatMap((row) =>
    (row.status === "fail" || row.status === "partial") &&
    row.summaryCode &&
    visibleCodes.has(row.summaryCode)
      ? [
          {
            id: String(row.checkId),
            source: "canonical-http" as const,
            status: row.status,
            labelCode: CHECK_LABEL_BY_ID.get(row.checkId) ?? `check_${row.checkId}`,
            summaryCode: row.summaryCode,
            impactCode: row.userImpactCode,
            remediationCode: row.fixCode,
            evidence: {},
          },
        ]
      : [],
  );
  const generated = generateRemediationPrompt({
    scope: "teaser",
    host: scan.targetHost,
    findings: canonicalFindings,
  });
  return {
    version: "remediation-prompt-v1.0.0",
    scope: "teaser",
    content: generated.content,
    included_findings: generated.includedFindings,
    generated_at: new Date().toISOString(),
  };
}

export async function getFullRemediationPrompt(
  scanId: string,
  cookieHeader: string | undefined | null,
): Promise<RemediationPromptResponse | undefined> {
  const report = await getFullReport(scanId, cookieHeader);
  if (!report) return undefined;
  const browser = await getFullBrowserObservation(scanId, cookieHeader);
  const canonicalFindings: RemediationFindingInput[] = report.checks.flatMap((check) =>
    check.status === "fail" || check.status === "partial"
      ? [
          {
            id: String(check.id),
            source: "canonical-http" as const,
            status: check.status,
            labelCode: check.label_code,
            summaryCode: check.summary_code,
            impactCode: check.user_impact_code,
            remediationCode: check.fix_code,
            evidence: check.evidence,
          },
        ]
      : [],
  );
  const generated = generateRemediationPrompt({
    scope: "full",
    host: report.host,
    findings: [...canonicalFindings, ...fromBrowser(browser?.findings)],
  });
  return {
    version: "remediation-prompt-v1.0.0",
    scope: "full",
    content: generated.content,
    included_findings: generated.includedFindings,
    generated_at: new Date().toISOString(),
  };
}
