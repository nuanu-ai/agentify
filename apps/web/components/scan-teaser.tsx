import { canonicalFindingHeadline, canonicalSummaryCopy } from "@agentify/remediation";
import type { ScanStatusResponse } from "@agentify/scanner-contracts";
import { Badge } from "@agentify/ui";
import type { ReactNode } from "react";

import { scanDay } from "../lib/levels";
import { unexplainedUnavailable } from "../lib/robots-notice";
import { SCAN_STATUS_LINES } from "../lib/scan-status";
import { CheckRow } from "./check-row";
import { CopyRemediationPrompt } from "./copy-remediation-prompt";
import { PublicShareActions } from "./public-share-actions";
import { RegistrationForm } from "./registration-form";
import { columnsFor } from "./report-actions";
import row from "./report-actions.module.css";
import { ResultHead } from "./result-head";
import layout from "./result-layout.module.css";
import { RobotsNotice } from "./robots-notice";
import styles from "./scan-teaser.module.css";
import { StatusBadge } from "./status-badge";

/**
 * The result of a finished scan: its level and score, what it found first, the
 * public link and the fix prompt where they are on, and beside them the ask
 * for the full report; `browser` is what a real browser observed, drawn at the
 * foot of the result. It is loaded once a scan has a result to show, with the
 * panels and the form it carries.
 */
export function ScanTeaser({
  browser,
  data,
  notice,
  publicShareEnabled,
  remediationPromptEnabled,
  registrationEnabled,
  scanId,
}: Readonly<{
  browser: ReactNode;
  data: ScanStatusResponse;
  notice: ReactNode;
  publicShareEnabled: boolean;
  remediationPromptEnabled: boolean;
  registrationEnabled: boolean;
  scanId: string;
}>) {
  const teaser = data.teaser;
  if (!teaser) return null;
  const shareShown = publicShareEnabled && teaser.score !== null;
  const promptShown =
    remediationPromptEnabled && registrationEnabled && teaser.top_findings.length > 0;
  const hidden = teaser.hidden_count;

  return (
    <div className={layout.columns}>
      <div className={layout.sheet}>
        <section>
          {notice}
          <ResultHead
            coverage={teaser.coverage}
            host={data.target_host}
            level={teaser.level}
            line={[SCAN_STATUS_LINES[data.status], scanDay(data.updated_at)]
              .filter(Boolean)
              .join(" · ")}
            score={teaser.score}
          />
          <RobotsNotice checks={data.checks} className={layout.note}>
            {unexplainedUnavailable(data.checks).length ? (
              <p data-unavailable-notice>
                Some checks were unavailable. They reduce coverage and are not treated as confirmed
                failures.
              </p>
            ) : null}
          </RobotsNotice>
          {shareShown || promptShown ? (
            <div className={row.share}>
              <div
                className={row.row}
                data-columns={columnsFor((shareShown ? 2 : 0) + (promptShown ? 2 : 0))}
              >
                <PublicShareActions
                  enabled={publicShareEnabled}
                  preview={{ hostLabel: null, level: teaser.level, score: teaser.score }}
                  scanId={scanId}
                  tokenStorageKey={`agentify:scan-token:${scanId}`}
                />
                {promptShown ? (
                  <CopyRemediationPrompt
                    allowDownload
                    contactGateScanId={scanId}
                    downloadUrl={`/api/v1/scans/${encodeURIComponent(scanId)}/remediation-prompt/download`}
                    label="Copy AI fix prompt"
                    promptUrl={`/api/v1/scans/${encodeURIComponent(scanId)}/remediation-prompt?scope=teaser`}
                    secondary
                  />
                ) : null}
              </div>
              {shareShown ? (
                <p className={row.note}>
                  Copy share link and Publish image both publish a link anyone can open, which shows
                  only the domain, level, score, and scan date. You can revoke it.
                </p>
              ) : null}
            </div>
          ) : null}
        </section>
        {teaser.top_findings.length > 0 || teaser.positive ? (
          <section>
            <div className={layout.sectionHead}>
              <h2>Top findings</h2>
            </div>
            {teaser.top_findings.map((code, index) => (
              <CheckRow
                detail={<p>{canonicalSummaryCopy(code)}</p>}
                fold={index === 0 ? "open" : "closed"}
                key={code}
                state={<Badge tone="partial">Needs attention</Badge>}
                title={canonicalFindingHeadline(code)}
              />
            ))}
            {teaser.positive ? (
              <CheckRow
                state={<StatusBadge status="pass" />}
                title={canonicalSummaryCopy(teaser.positive).replace(/\.$/, "")}
              />
            ) : null}
          </section>
        ) : null}
      </div>
      <div className={layout.aside}>
        <section className={`${layout.panel} ${layout.tinted} ${styles.unlock}`} id="registration">
          <h2>
            {hidden > 0
              ? `${hidden} more ${hidden === 1 ? "check" : "checks"} in the full report`
              : "Get the complete diagnostic context"}
          </h2>
          {registrationEnabled ? (
            <RegistrationForm scanId={scanId} />
          ) : (
            <p className={layout.lead}>Email verification is not enabled in this deployment yet.</p>
          )}
        </section>
      </div>
      <div className={layout.after}>{browser}</div>
    </div>
  );
}
