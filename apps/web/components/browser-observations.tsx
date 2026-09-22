"use client";

import {
  type BrowserObservationFinding,
  type BrowserObservationStatusResponse,
  browserObservationStatusResponseSchema,
} from "@agentify/scanner-contracts";
import { useEffect, useId, useState } from "react";

import { DISPLAY_BRAND } from "../lib/brand";
import {
  browserObservationImpact,
  browserObservationLabel,
  browserObservationSummary,
  formatRegistryCode,
  isActionableBrowserFinding,
  isExperimentalBrowserObservation,
  safeEvidenceEntries,
} from "../lib/browser-observation-ui";
import { buildBrowserFixPrompt } from "../lib/fix-prompts";
import styles from "./browser-observations.module.css";
import { CopyRemediationPrompt } from "./copy-remediation-prompt";
import { StatusBadge } from "./status-badge";

type ViewState = "hidden" | "ready" | "error";

export function BrowserObservations({
  host,
  initialData,
  remediationPromptEnabled = false,
  scanId,
  surface,
}: Readonly<{
  host?: string;
  initialData?: BrowserObservationStatusResponse | null;
  remediationPromptEnabled?: boolean;
  scanId: string;
  surface: "scan" | "report";
}>) {
  const titleId = useId();
  const [data, setData] = useState<BrowserObservationStatusResponse | null>(
    initialData ?? null,
  );
  const [viewState, setViewState] = useState<ViewState>(
    initialData ? "ready" : "hidden",
  );

  useEffect(() => {
    if (surface !== "scan" || initialData) return;
    let cancelled = false;
    let timer: number | undefined;
    let missingTokenAttempts = 0;
    const controller = new AbortController();

    async function load() {
      const token =
        sessionStorage.getItem(`agentify:scan-token:${scanId}`) ??
        new URLSearchParams(window.location.hash.slice(1)).get("access_token");
      if (!token) {
        if (missingTokenAttempts < 3) {
          missingTokenAttempts += 1;
          timer = window.setTimeout(() => void load(), 100);
        }
        return;
      }
      try {
        const response = await fetch(
          `/api/v1/scans/${encodeURIComponent(scanId)}/browser-observation`,
          {
            cache: "no-store",
            headers: { Authorization: `Bearer ${token}` },
            signal: controller.signal,
          },
        );
        if (cancelled) return;
        if (
          response.status === 204 ||
          response.status === 401 ||
          response.status === 403 ||
          response.status === 404
        ) {
          setViewState("hidden");
          return;
        }
        if (!response.ok) {
          setViewState("error");
          return;
        }
        const payload: unknown = await response.json();
        const parsed =
          browserObservationStatusResponseSchema.safeParse(payload);
        if (!parsed.success) {
          setViewState("error");
          return;
        }
        setData(parsed.data);
        setViewState("ready");
        if (["queued", "running"].includes(parsed.data.status)) {
          timer = window.setTimeout(() => void load(), 2500);
        }
      } catch (error) {
        if (
          !cancelled &&
          !(error instanceof DOMException && error.name === "AbortError")
        )
          setViewState("error");
      }
    }

    timer = window.setTimeout(() => void load());
    return () => {
      cancelled = true;
      controller.abort();
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [initialData, scanId, surface]);

  if (viewState === "hidden") return null;
  if (viewState === "error") {
    return (
      <section aria-labelledby={titleId} className={styles.panel}>
        <PanelHeader
          status="unavailable"
          titleId={titleId}
          title="Browser observations are temporarily unavailable"
        />
        <p className={styles.notice}>
          The 18-check report is unaffected. This is not a failure of your site.
        </p>
      </section>
    );
  }
  if (!data) return null;

  const visibleFindings = selectVisibleFindings(data.findings, surface);
  return (
    <section aria-labelledby={titleId} className={styles.panel}>
      <PanelHeader
        status={data.status}
        titleId={titleId}
        title={browserObservationSummary(data)}
      />
      <div className={styles.meta}>
        <span>Does not change the score</span>
        <span>{data.version}</span>
        <span>
          {data.pages_assessed} {data.pages_assessed === 1 ? "page" : "pages"}
        </span>
      </div>

      {data.status === "queued" || data.status === "running" ? (
        <p aria-live="polite" className={styles.notice} role="status">
          This step runs after the report.
        </p>
      ) : null}
      {data.status === "blocked" ? (
        <p className={styles.notice}>
          A robots, WAF, login, or challenge boundary stopped public rendering.
          No bypass was attempted. This is shown as unavailable context, not a
          site failure.
        </p>
      ) : null}
      {data.status === "unavailable" ? (
        <p className={styles.notice}>
          The browser step could not finish. The report is unchanged.
        </p>
      ) : null}

      {visibleFindings.length > 0 ? (
        <div className={styles.findings}>
          {visibleFindings.map((finding) => (
            <BrowserFinding
              finding={finding}
              host={host}
              key={finding.id}
              remediationPromptEnabled={remediationPromptEnabled}
              surface={surface}
            />
          ))}
        </div>
      ) : ["completed", "partial"].includes(data.status) ? (
        <p className={styles.notice}>
          No actionable browser finding was included in this view.
        </p>
      ) : null}
    </section>
  );
}

function PanelHeader({
  status,
  title,
  titleId,
}: Readonly<{
  status: BrowserObservationStatusResponse["status"];
  title: string;
  titleId: string;
}>) {
  return (
    <header className={styles.header}>
      <div>
        <span className="eyebrow">Browser observations</span>
        <h2 id={titleId}>{title}</h2>
      </div>
      <span className={`${styles.lifecycle} ${styles[status]}`}>
        <span aria-hidden="true" />
        {status}
      </span>
    </header>
  );
}

function BrowserFinding({
  finding,
  host,
  remediationPromptEnabled,
  surface,
}: Readonly<{
  finding: BrowserObservationFinding;
  host?: string;
  remediationPromptEnabled: boolean;
  surface: "scan" | "report";
}>) {
  const evidence = safeEvidenceEntries(finding.evidence);
  const actionable = isActionableBrowserFinding(finding);
  const body = (
    <div className={styles.findingBody}>
      <p>{formatRegistryCode(finding.summary_code)}</p>
      <p>
        {finding.user_impact_code
          ? formatRegistryCode(finding.user_impact_code)
          : browserObservationImpact(finding.id)}
      </p>
      {actionable && finding.remediation_code ? (
        <p>
          <strong>Fix:</strong> {formatRegistryCode(finding.remediation_code)}
        </p>
      ) : null}
      {surface === "report" && evidence.length > 0 ? (
        <dl>
          {evidence.map(({ key, label, value }) => (
            <div key={key}>
              <dt>{label}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      {surface === "report" &&
      actionable &&
      host &&
      remediationPromptEnabled ? (
        <CopyRemediationPrompt
          label="Copy this fix"
          prompt={buildBrowserFixPrompt(host, finding, DISPLAY_BRAND)}
          secondary
        />
      ) : null}
    </div>
  );

  if (surface === "scan") {
    return (
      <article className={styles.finding}>
        <div className={styles.findingHeader}>
          <strong>{browserObservationLabel(finding.id)}</strong>
          {isExperimentalBrowserObservation(finding.id) ? (
            <span className={styles.experimental}>Experimental</span>
          ) : null}
          <StatusBadge status={finding.status} />
        </div>
        {body}
      </article>
    );
  }

  return (
    <details className={styles.finding} open={finding.status === "fail"}>
      <summary className={styles.findingHeader}>
        <strong>{browserObservationLabel(finding.id)}</strong>
        {isExperimentalBrowserObservation(finding.id) ? (
          <span className={styles.experimental}>Experimental</span>
        ) : null}
        <StatusBadge status={finding.status} />
      </summary>
      {body}
    </details>
  );
}

function selectVisibleFindings(
  findings: BrowserObservationFinding[],
  surface: "scan" | "report",
): BrowserObservationFinding[] {
  if (surface === "report") return findings;
  const actionable = findings.filter(isActionableBrowserFinding).slice(0, 3);
  if (actionable.length > 0) return actionable;
  const positive = findings.find((finding) => finding.status === "pass");
  return positive ? [positive] : [];
}
