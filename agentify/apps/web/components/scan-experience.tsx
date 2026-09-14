"use client";

import Link from "next/link";
import React from "react";
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
} from "react";

import {
  CHECK_DEFINITIONS,
  scanStatusResponseSchema,
  type DiagnosticLevel,
  type ScanStatusResponse,
  type Segment,
} from "@b2a/contracts";
import {
  canonicalFindingHeadline,
  canonicalSummaryCopy,
} from "@b2a/remediation";

import { useCountUp } from "../lib/count-up";
import { Brand } from "./brand";
import { BrowserObservations } from "./browser-observations";
import { CopyRemediationPrompt } from "./copy-remediation-prompt";
import { PrivacyChoicesButton } from "./privacy-choices-button";
import { PublicShareActions } from "./public-share-actions";
import { RegistrationForm } from "./registration-form";
import { StatusBadge } from "./status-badge";
import styles from "./scan-experience.module.css";

const CHECK_LABELS = {
  robots: "robots.txt",
  ai_policy: "Explicit AI crawler policy",
  content_signal: "Content-Signal policy",
  sitemap: "Sitemap",
  json_ld_presence: "Structured data presence",
  vertical_json_ld: "Business-specific structured data",
  markdown_negotiation: "Markdown negotiation",
  llms_txt: "llms.txt",
  mcp_server_card: "MCP server card",
  ucp_profile: "UCP profile",
  oauth_discovery: "OAuth discovery",
  raw_html_ssr: "Server-rendered content",
  agent_ua_accessibility: "Agent-UA accessibility",
  page_weight_latency: "Page weight and latency",
  store_feed_signals: "Store feed signals",
  platform_fingerprint: "Platform fingerprint",
  a2a_agent_card: "A2A agent card",
  hreflang_locales: "Language alternatives",
} as const;

type FixtureName = "running" | "partial" | "failed" | "blocked" | "teaser";

export function ScanExperience({
  browserObservationsEnabled,
  fixture,
  publicShareEnabled,
  remediationPromptEnabled,
  registrationEnabled,
  scanId,
  segment,
}: Readonly<{
  browserObservationsEnabled: boolean;
  fixture?: string;
  publicShareEnabled: boolean;
  remediationPromptEnabled: boolean;
  registrationEnabled: boolean;
  scanId: string;
  segment: Segment;
}>) {
  const fixtureName = parseFixtureName(fixture);
  const [data, setData] = useState<ScanStatusResponse | null>(() =>
    fixtureName ? createDevFixture(fixtureName) : null,
  );
  const [accessState, setAccessState] = useState<
    "loading" | "ready" | "missing" | "invalid"
  >(fixtureName ? "ready" : "loading");
  const [requestError, setRequestError] = useState<string | null>(null);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const terminal = data
    ? ["completed", "partial", "failed"].includes(data.status)
    : false;

  useEffect(() => {
    if (terminal || fixtureName) return;
    const startedAt = Date.now();
    const timer = window.setInterval(
      () => setElapsedSeconds(Math.floor((Date.now() - startedAt) / 1000)),
      1_000,
    );
    return () => window.clearInterval(timer);
  }, [fixtureName, terminal]);

  const poll = useCallback(async () => {
    if (fixtureName) return;
    const token = getStoredToken(scanId);
    if (!token) {
      setAccessState("missing");
      return;
    }
    setAccessState("ready");
    try {
      const response = await fetch(
        `/api/v1/scans/${encodeURIComponent(scanId)}/status`,
        {
          cache: "no-store",
          headers: { Authorization: `Bearer ${token}` },
        },
      );
      if (response.status === 401 || response.status === 403) {
        setAccessState("invalid");
        return;
      }
      const payload: unknown = await response.json();
      const parsed = scanStatusResponseSchema.safeParse(payload);
      if (!response.ok || !parsed.success) {
        setRequestError(
          "The scanner returned an invalid or unavailable status response.",
        );
        return;
      }
      setData(parsed.data);
      setRequestError(null);
    } catch {
      setRequestError(
        "Live status is temporarily unreachable. We will keep trying.",
      );
    }
  }, [fixtureName, scanId]);

  useEffect(() => {
    if (fixtureName) return;
    captureFragmentToken(scanId);
    void poll();
  }, [fixtureName, poll, scanId]);

  useEffect(() => {
    if (
      fixtureName ||
      terminal ||
      accessState === "invalid" ||
      accessState === "missing"
    )
      return;
    const interval = window.setInterval(
      () => void poll(),
      data?.status === "running" ? 1000 : 2000,
    );
    return () => window.clearInterval(interval);
  }, [accessState, data?.status, fixtureName, poll, terminal]);

  useEffect(() => {
    if (!data?.teaser || fixtureName || accessState !== "ready") return;
    window.dispatchEvent(
      new CustomEvent("b2a:analytics-event", {
        detail: { name: "results_viewed", scanId },
      }),
    );
  }, [accessState, data?.teaser, fixtureName, scanId]);

  const phases = useMemo(() => buildPhases(data, segment), [data, segment]);

  return (
    <main className={styles.page}>
      <div className={styles.brandWrap}>
        <Brand />
      </div>
      <section className={styles.card}>
        <header className={styles.scanHeader}>
          <div>
            <span className={styles.scanId}>
              {data?.target_host ?? "Private website diagnostic"}
            </span>
            <span>{scanStatusLine(data?.status, accessState)}</span>
          </div>
          <ScanStateBadge accessState={accessState} status={data?.status} />
        </header>

        {fixtureName ? (
          <div className={styles.fixtureBanner}>
            Development fixture: {fixtureName}. This is not live scan evidence.
          </div>
        ) : null}

        {accessState === "loading" ? <LoadingState /> : null}
        {accessState === "missing" || accessState === "invalid" ? (
          <AccessError invalid={accessState === "invalid"} />
        ) : null}
        {accessState === "ready" && !data ? <LoadingState /> : null}
        {data && !terminal ? (
          <ProgressState
            data={data}
            elapsedSeconds={elapsedSeconds}
            phases={phases}
          />
        ) : null}
        {data?.status === "failed" ? (
          <FailedState
            blocked={fixtureName === "blocked"}
            onRetry={() => window.location.assign("/owner")}
          />
        ) : null}
        {data && (data.status === "completed" || data.status === "partial") ? (
          data.teaser ? (
            <TeaserState
              data={data}
              publicShareEnabled={publicShareEnabled}
              remediationPromptEnabled={remediationPromptEnabled}
              registrationEnabled={registrationEnabled}
              scanId={scanId}
            />
          ) : (
            <FailedState blocked={false} onRetry={() => void poll()} />
          )
        ) : null}

        {requestError ? (
          <div aria-live="polite" className={styles.pollNotice}>
            {requestError}
          </div>
        ) : null}
      </section>
      {browserObservationsEnabled &&
      data?.teaser &&
      (data.status === "completed" || data.status === "partial") ? (
        <div className={styles.browserWrap}>
          <BrowserObservations scanId={scanId} surface="scan" />
        </div>
      ) : null}
      <nav aria-label="Scan help" className={styles.helpLinks}>
        <Link href="/scanner">Scanner identity</Link>
        <Link href="/methodology">Methodology</Link>
        <Link href="/privacy">Privacy</Link>
        <PrivacyChoicesButton className={styles.helpAction} />
      </nav>
    </main>
  );
}

type Phase = Readonly<{
  label: string;
  status: "done" | "active" | "pending" | "unavailable";
}>;

function buildPhases(
  data: ScanStatusResponse | null,
  segment: Segment,
): readonly Phase[] {
  const labels = [
    "Checking safe access to the site",
    "Reading robots.txt and sitemap",
    "Checking structured data",
    "Comparing regular and agent-readable output",
    segment === "store"
      ? "Checking catalog signals"
      : segment === "local"
        ? "Checking local business signals"
        : "Checking public business signals",
    "Assembling the diagnostic report",
  ] as const;
  if (!data)
    return labels.map((label, index) => ({
      label,
      status: index === 0 ? "active" : "pending",
    }));
  if (data.status === "accepted" || data.status === "queued") {
    return labels.map((label) => ({ label, status: "pending" }));
  }

  const terminalChecks = data.checks.filter((check) =>
    ["pass", "partial", "fail", "unavailable", "not_applicable"].includes(
      check.status,
    ),
  ).length;
  const runningChecks = data.checks
    .filter((check) => check.status === "running")
    .map((check) => check.id);
  const phaseIndex = runningChecks.some((id) => [1, 4].includes(id))
    ? 1
    : runningChecks.some((id) => [5, 6].includes(id))
      ? 2
      : runningChecks.some((id) => [7, 12, 13, 14].includes(id))
        ? 3
        : runningChecks.length > 0
          ? 4
          : terminalChecks >= 18
            ? 5
            : Math.min(4, Math.max(0, Math.floor(terminalChecks / 4)));

  return labels.map((label, index) => ({
    label,
    status:
      index < phaseIndex ? "done" : index === phaseIndex ? "active" : "pending",
  }));
}

function ProgressState({
  data,
  elapsedSeconds,
  phases,
}: Readonly<{
  data: ScanStatusResponse;
  elapsedSeconds: number;
  phases: readonly Phase[];
}>) {
  return (
    <div className={styles.progress}>
      <div aria-atomic="true" aria-live="polite" className="sr-only">
        Scan {data.status}. {data.progress.completed} of {data.progress.total}{" "}
        checks have a terminal result.
      </div>
      <ol className={styles.phases}>
        {phases.map((phase, index) => (
          <li
            className={styles[phase.status]}
            key={phase.label}
            style={{ "--i": index } as CSSProperties}
          >
            <span aria-hidden="true" className={styles.phaseIcon}>
              {phase.status === "done" ? "✓" : index + 1}
            </span>
            <span>{phase.label}</span>
            <span className="mono">
              {phase.status === "active" ? "reading…" : phase.status}
            </span>
          </li>
        ))}
      </ol>
      <p className={styles.phaseCount}>
        <span>
          {data.status === "queued" || data.status === "accepted"
            ? "Waiting for scanner capacity"
            : `${data.progress.completed} of ${data.progress.total} canonical checks reported`}
        </span>
        <span className="mono">{elapsedSeconds}s · usually under 60 s</span>
      </p>
      {data.checks.length > 0 ? (
        <details className={styles.checkDetails}>
          <summary>Live check details</summary>
          <div>
            {data.checks.map((check) => (
              <div key={check.id}>
                <span>{labelFor(check.label_code)}</span>
                <StatusBadge status={check.status} />
              </div>
            ))}
          </div>
        </details>
      ) : null}
    </div>
  );
}

function TeaserState({
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
  const displayScore = useCountUp(data.teaser?.score ?? 0);
  const teaser = data.teaser;
  if (!teaser) return null;
  const provisional = teaser.coverage < 0.7 || teaser.level === "incomplete";

  return (
    <div className={styles.teaser}>
      {data.status === "partial" ? (
        <div className={styles.partialNotice}>
          Some checks were unavailable. They reduce coverage and are not treated
          as confirmed failures.
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
            {displayScore}
            <span>/100</span>
          </div>
        )}
      </div>
      {teaser.score === null ? null : <ScoreScale score={teaser.score} />}
      <div className={styles.coverageLine}>
        <span>Diagnostic level, not a certification</span>
        <span>Coverage {Math.round(teaser.coverage * 100)}%</span>
      </div>
      <div className={styles.teaserActions}>
        <span className="eyebrow">Your result is ready</span>
        <div className={styles.teaserActionRows}>
          <PublicShareActions
            enabled={publicShareEnabled}
            preview={{
              hostLabel: null,
              level: teaser.level,
              score: teaser.score,
            }}
            scanId={scanId}
            tokenStorageKey={`b2a:scan-token:${scanId}`}
          />
          {remediationPromptEnabled &&
          registrationEnabled &&
          teaser.top_findings.length > 0 ? (
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
        <p className={styles.teaserCaption}>
          The public link shows only the domain, level, score, and scan date.
          {remediationPromptEnabled && registrationEnabled
            ? " Prompt and .md unlock after a confirmed email."
            : ""}
        </p>
      </div>
      <div className={styles.findings}>
        <span className="eyebrow">Top findings</span>
        {teaser.top_findings.map((finding, index) => (
          <Finding
            code={finding}
            index={index}
            key={finding}
            status="attention"
          />
        ))}
        {teaser.positive ? (
          <Finding
            code={teaser.positive}
            index={teaser.top_findings.length}
            status="pass"
          />
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
              ? "The full report requires email, phone, and one secure email confirmation."
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
      <div
        className={`${styles.finding} ${styles.pass}`}
        style={{ "--i": index } as CSSProperties}
      >
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
        <strong className={styles.findingHeadline}>
          {canonicalFindingHeadline(code)}
        </strong>
        <span aria-hidden="true" className={styles.findingChevron}>
          +
        </span>
      </summary>
      <p className={styles.findingDetail}>
        <strong>What we found:</strong> {summary}
      </p>
    </details>
  );
}

function ScoreScale({ score }: Readonly<{ score: number }>) {
  return (
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

function FailedState({
  blocked,
  onRetry,
}: Readonly<{ blocked: boolean; onRetry: () => void }>) {
  return (
    <div className={styles.failed}>
      <span aria-hidden="true">◔</span>
      <h1>
        {blocked
          ? "The site blocked our reader"
          : "No reliable diagnostic was produced"}
      </h1>
      <p>
        {blocked
          ? "Public requests were blocked before enough checks could reach a verdict. No score or registration gate is shown."
          : "Coverage stayed below the minimum for an honest result. This can happen after a timeout, access block, or scanner failure."}
      </p>
      <button className="button button-primary" onClick={onRetry} type="button">
        Try again
      </button>
    </div>
  );
}

function AccessError({ invalid }: Readonly<{ invalid: boolean }>) {
  return (
    <div className={styles.failed}>
      <span aria-hidden="true">↗</span>
      <h1>
        {invalid
          ? "This scan link is no longer valid"
          : "Open the original private scan link"}
      </h1>
      <p>
        Scan progress is private. The access token stays in this browser session
        and is never put in a query parameter.
      </p>
      <Link className="button button-primary" href="/owner">
        Start a new scan
      </Link>
    </div>
  );
}

function LoadingState() {
  return (
    <div aria-live="polite" className={styles.loading}>
      Reading the private scan state…
    </div>
  );
}

function ScanStateBadge({
  accessState,
  status,
}: Readonly<{
  accessState: "loading" | "ready" | "missing" | "invalid";
  status?: ScanStatusResponse["status"];
}>) {
  if (accessState === "missing" || accessState === "invalid")
    return <StatusBadge status="unavailable" />;
  if (status === "failed") return <StatusBadge status="fail" />;
  if (status === "completed") return <StatusBadge status="complete" />;
  if (status === "partial") return <StatusBadge status="partial" />;
  return <StatusBadge status="running" />;
}

function scanStatusLine(
  status: ScanStatusResponse["status"] | undefined,
  accessState: "loading" | "ready" | "missing" | "invalid",
) {
  if (accessState === "missing" || accessState === "invalid")
    return "Private access required";
  if (!status) return "Reading scan state…";
  const lines: Record<ScanStatusResponse["status"], string> = {
    accepted: "Scan accepted",
    queued: "Waiting for scanner capacity",
    running: "Reading public signals…",
    completed: "Scan complete",
    partial: "Scan complete with unavailable checks",
    failed: "Scan ended without a reliable result",
  };
  return lines[status];
}

function captureFragmentToken(scanId: string) {
  const fragment = new URLSearchParams(window.location.hash.slice(1));
  const token = fragment.get("access_token");
  if (!token) return;
  sessionStorage.setItem(`b2a:scan-token:${scanId}`, token);
  window.history.replaceState(
    null,
    "",
    `${window.location.pathname}${window.location.search}`,
  );
}

function getStoredToken(scanId: string) {
  return sessionStorage.getItem(`b2a:scan-token:${scanId}`);
}

function parseFixtureName(value?: string): FixtureName | undefined {
  if (process.env.NODE_ENV === "production") return undefined;
  return value &&
    ["running", "partial", "failed", "blocked", "teaser"].includes(value)
    ? (value as FixtureName)
    : undefined;
}

function createDevFixture(name: FixtureName): ScanStatusResponse {
  const now = new Date().toISOString();
  if (name === "failed" || name === "blocked") {
    return {
      status: "failed",
      progress: { completed: 4, total: 18 },
      checks: CHECK_DEFINITIONS.slice(0, 4).map((check) => ({
        id: check.id,
        label_code: check.labelCode,
        status: "unavailable" as const,
      })),
      updated_at: now,
      target_host: "example.com",
    };
  }
  if (name === "running") {
    return {
      status: "running",
      progress: { completed: 7, total: 18 },
      checks: CHECK_DEFINITIONS.slice(0, 9).map((check, index) => ({
        id: check.id,
        label_code: check.labelCode,
        status:
          index < 7
            ? ("pass" as const)
            : index === 7
              ? ("running" as const)
              : ("pending" as const),
      })),
      updated_at: now,
      target_host: "example.com",
    };
  }
  return {
    status: name === "partial" ? "partial" : "completed",
    progress: { completed: 18, total: 18 },
    checks: CHECK_DEFINITIONS.map((check, index) => ({
      id: check.id,
      label_code: check.labelCode,
      status:
        name === "partial" && index > 13
          ? ("unavailable" as const)
          : index % 4 === 0
            ? ("partial" as const)
            : ("pass" as const),
    })),
    updated_at: now,
    target_host: "example.com",
    teaser: {
      score: 46,
      coverage: name === "partial" ? 0.78 : 1,
      level: "readable",
      top_findings: ["vertical_jsonld_missing", "markdown_negotiation_absent"],
      positive: "ssr_content_substantive",
      hidden_count: 7,
    },
  };
}

function labelFor(labelCode: string) {
  return (
    CHECK_LABELS[labelCode as keyof typeof CHECK_LABELS] ??
    labelCode.replaceAll("_", " ")
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
