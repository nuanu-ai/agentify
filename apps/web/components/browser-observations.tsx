import type {
  BrowserObservationFinding,
  BrowserObservationStatusResponse,
} from "@agentify/scanner-contracts";
import { Badge, type BadgeTone } from "@agentify/ui";
import { useEffect, useId, useState } from "react";

import {
  browserObservationImpact,
  browserObservationLabel,
  formatRegistryCode,
  isActionableBrowserFinding,
  isExperimentalBrowserObservation,
  safeEvidenceEntries,
} from "../lib/browser-observation-ui";
import styles from "./browser-observations.module.css";
import { CheckRow } from "./check-row";
import { CopyRemediationPrompt } from "./copy-remediation-prompt";
import layout from "./result-layout.module.css";
import { StatusBadge } from "./status-badge";

type ViewState = "hidden" | "ready" | "error";

/**
 * What a real browser observed on the site, beside the report and outside its
 * score. The scan page asks for it while the observation runs; the report is
 * handed it whole, with the prompt that fixes each actionable finding.
 */
export function BrowserObservations({
  fixPrompts = {},
  initialData,
  scanId,
  surface,
}: Readonly<{
  fixPrompts?: Readonly<Record<string, string>>;
  initialData?: BrowserObservationStatusResponse | null;
  scanId: string;
  surface: "scan" | "report";
}>) {
  const titleId = useId();
  const [data, setData] = useState<BrowserObservationStatusResponse | null>(initialData ?? null);
  const [viewState, setViewState] = useState<ViewState>(initialData ? "ready" : "hidden");

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
        const [payload, { browserObservationStatusResponseSchema }] = await Promise.all([
          response.json() as Promise<unknown>,
          import("@agentify/scanner-contracts"),
        ]);
        const parsed = browserObservationStatusResponseSchema.safeParse(payload);
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
        if (!cancelled && !(error instanceof DOMException && error.name === "AbortError"))
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
      <section aria-labelledby={titleId}>
        <PanelHeader status="unavailable" titleId={titleId} />
        <p className={styles.notice}>
          Browser observations are temporarily unavailable. The 18-check report is unaffected. This
          is not a failure of your site.
        </p>
      </section>
    );
  }
  if (!data) return null;

  const visibleFindings = selectVisibleFindings(data.findings, surface);
  return (
    <section aria-labelledby={titleId}>
      <PanelHeader
        meta={[
          "Does not change the score",
          `${data.pages_assessed} ${data.pages_assessed === 1 ? "page" : "pages"}`,
          // The full report names the method's version, as its methodology does.
          ...(surface === "report" ? [data.version] : []),
        ].join(" · ")}
        status={data.status}
        titleId={titleId}
      />

      {data.status === "queued" || data.status === "running" ? (
        <p aria-live="polite" className={styles.notice} role="status">
          This step runs after the report.
        </p>
      ) : null}
      {data.status === "partial" ? (
        <p className={styles.notice}>Browser observations complete with unavailable surfaces.</p>
      ) : null}
      {data.status === "blocked" ? (
        <p className={styles.notice}>
          A robots, WAF, login, or challenge boundary stopped public rendering. No bypass was
          attempted. This is shown as unavailable context, not a site failure.
        </p>
      ) : null}
      {data.status === "unavailable" ? (
        <p className={styles.notice}>The browser step could not finish. The report is unchanged.</p>
      ) : null}

      {visibleFindings.length > 0 ? (
        <div className={styles.findings}>
          {visibleFindings.map((finding) => (
            <BrowserFinding
              finding={finding}
              fixPrompt={fixPrompts[finding.id]}
              key={finding.id}
              surface={surface}
            />
          ))}
        </div>
      ) : ["completed", "partial"].includes(data.status) ? (
        <p className={styles.notice}>No actionable browser finding was included in this view.</p>
      ) : null}
    </section>
  );
}

const LIFECYCLE: Record<BrowserObservationStatusResponse["status"], readonly [string, BadgeTone]> =
  {
    queued: ["Queued", "progress"],
    running: ["Running", "progress"],
    completed: ["Completed", "pass"],
    partial: ["Partial", "partial"],
    blocked: ["Blocked", "quiet"],
    unavailable: ["Unavailable", "quiet"],
  };

function PanelHeader({
  meta,
  status,
  titleId,
}: Readonly<{
  meta?: string;
  status: BrowserObservationStatusResponse["status"];
  titleId: string;
}>) {
  const [word, tone] = LIFECYCLE[status];
  return (
    <header className={layout.sectionHead}>
      <h2 id={titleId}>Browser check</h2>
      <Badge tone={tone}>{word}</Badge>
      {meta ? <span className={layout.quiet}>{meta}</span> : null}
    </header>
  );
}

function BrowserFinding({
  finding,
  fixPrompt,
  surface,
}: Readonly<{
  finding: BrowserObservationFinding;
  fixPrompt?: string;
  surface: "scan" | "report";
}>) {
  const evidence = safeEvidenceEntries(finding.evidence);
  const actionable = isActionableBrowserFinding(finding);
  // The scan shows its few findings whole; the report folds every one, a
  // failure open.
  return (
    <CheckRow
      detail={
        <>
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
            <dl className={styles.evidence}>
              {evidence.map(({ key, label, value }) => (
                <div key={key}>
                  <dt>{label}</dt>
                  <dd>{value}</dd>
                </div>
              ))}
            </dl>
          ) : null}
          {surface === "report" && actionable && fixPrompt !== undefined ? (
            <div className={styles.copyFix}>
              <CopyRemediationPrompt label="Copy this fix" prompt={fixPrompt} secondary />
            </div>
          ) : null}
        </>
      }
      fold={surface === "scan" ? undefined : finding.status === "fail" ? "open" : "closed"}
      state={<StatusBadge status={finding.status} />}
      title={
        <>
          {browserObservationLabel(finding.id)}
          {isExperimentalBrowserObservation(finding.id) ? (
            <span className={styles.experimental}>Experimental</span>
          ) : null}
        </>
      }
    />
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
