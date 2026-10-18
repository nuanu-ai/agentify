import { canonicalFindingHeadline, canonicalSummaryCopy } from "@agentify/remediation";
import type { DiagnosticLevel, ScanStatusResponse } from "@agentify/scanner-contracts";
import type { CSSProperties } from "react";

import { unexplainedUnavailable } from "../lib/robots-notice";
import { CopyRemediationPrompt } from "./copy-remediation-prompt";
import { PublicShareActions } from "./public-share-actions";
import { RegistrationForm } from "./registration-form";
import row from "./report-actions.module.css";
import { RobotsNotice } from "./robots-notice";
import styles from "./scan-experience.module.css";
import { StatusBadge } from "./status-badge";

/**
 * The result of a finished scan: its level and score, what it found first, the
 * public link and the fix prompt where they are on, and the ask for the full
 * report. It is loaded once a scan has a result to show, with the panels and
 * the form it carries.
 */
export function ScanTeaser({
  data,
  publicShareEnabled,
  remediationPromptEnabled,
  registrationEnabled,
  scanId,
}: Readonly<{
  data: ScanStatusResponse;
  publicShareEnabled: boolean;
  remediationPromptEnabled: boolean;
  registrationEnabled: boolean;
  scanId: string;
}>) {
  const teaser = data.teaser;
  if (!teaser) return null;
  const provisional = teaser.coverage < 0.7 || teaser.level === "incomplete";
  const shareShown = publicShareEnabled && teaser.score !== null;
  const promptShown =
    remediationPromptEnabled && registrationEnabled && teaser.top_findings.length > 0;

  return (
    <div className={styles.teaser}>
      <RobotsNotice checks={data.checks} className={styles.partialNotice} />
      {unexplainedUnavailable(data.checks).length ? (
        <div className={styles.partialNotice} data-unavailable-notice>
          Some checks were unavailable. They reduce coverage and are not treated as confirmed
          failures.
        </div>
      ) : null}
      <div className={styles.scoreLine}>
        <div>
          <span className="eyebrow">
            {provisional ? "Provisional diagnostic" : "Diagnostic level"}
          </span>
          <h1>{formatLevel(teaser.level)}</h1>
        </div>
        {teaser.score === null ? null : (
          <div className={styles.score}>
            {teaser.score}
            <span>/100</span>
          </div>
        )}
      </div>
      {teaser.score === null ? null : <ScoreScale score={teaser.score} />}
      <div className={styles.coverageLine}>
        <span>Diagnostic level, not a certification</span>
        <span>Coverage {Math.round(teaser.coverage * 100)}%</span>
      </div>
      {shareShown || promptShown ? (
        <div className={styles.teaserActions}>
          <div className={`${row.row} ${styles.teaserActionRows}`}>
            <PublicShareActions
              enabled={publicShareEnabled}
              preview={{
                hostLabel: null,
                level: teaser.level,
                score: teaser.score,
              }}
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
            <p className={styles.teaserCaption}>
              The public link shows only the domain, level, score, and scan date.
            </p>
          ) : null}
        </div>
      ) : null}
      <div className={styles.findings}>
        <h2 className="eyebrow">Top findings</h2>
        {teaser.top_findings.map((finding, index) => (
          <Finding code={finding} index={index} key={finding} status="attention" />
        ))}
        {teaser.positive ? (
          <Finding code={teaser.positive} index={teaser.top_findings.length} status="pass" />
        ) : null}
      </div>
      <div className={styles.reportCta} id="registration">
        <div>
          <strong>
            {teaser.hidden_count > 0
              ? `${teaser.hidden_count} more checks in the full report`
              : "Get the complete diagnostic context"}
          </strong>
          <span>
            {registrationEnabled
              ? "The full report requires your email and one secure email confirmation. A phone number is optional."
              : "Email verification is not enabled in this deployment yet."}
          </span>
        </div>
        {registrationEnabled ? <RegistrationForm scanId={scanId} /> : null}
      </div>
    </div>
  );
}

function Finding({
  code,
  index,
  status,
}: Readonly<{
  code: string;
  index: number;
  status: "attention" | "pass";
}>) {
  const summary = canonicalSummaryCopy(code);
  if (status === "pass") {
    return (
      <div className={`${styles.finding} ${styles.pass}`} style={{ "--i": index } as CSSProperties}>
        <StatusBadge status="pass" />
        <span>{summary}</span>
      </div>
    );
  }

  return (
    <details
      className={`${styles.finding} ${styles.attention}`}
      open={index === 0}
      style={{ "--i": index } as CSSProperties}
    >
      <summary className={styles.findingSummary}>
        <span className={styles.attentionBadge}>
          <span aria-hidden="true" />
          needs attention
        </span>
        <strong className={styles.findingHeadline}>{canonicalFindingHeadline(code)}</strong>
        <span aria-hidden="true" className={styles.findingChevron}>
          +
        </span>
      </summary>
      <p className={styles.findingDetail}>{summary}</p>
    </details>
  );
}

function ScoreScale({ score }: Readonly<{ score: number }>) {
  return (
    // biome-ignore lint/a11y/useSemanticElements: the custom meter draws diagnostic thresholds alongside its fill; its value and bounds are exposed here
    <div
      aria-label={`Diagnostic score ${score} out of 100`}
      aria-valuemax={100}
      aria-valuemin={0}
      aria-valuenow={score}
      className={styles.scale}
      role="meter"
    >
      <div className={styles.scaleFill} style={{ width: `${score}%` }} />
      <i style={{ left: "25%" }} />
      <i style={{ left: "50%" }} />
      <i style={{ left: "70%" }} />
    </div>
  );
}

function formatLevel(level: DiagnosticLevel) {
  const labels: Record<DiagnosticLevel, string> = {
    invisible: "Invisible",
    readable: "Readable",
    callable_ready: "Callable-ready",
    ahead_of_market: "Ahead of the market",
    incomplete: "Incomplete",
  };
  return labels[level];
}
