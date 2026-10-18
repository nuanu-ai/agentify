import { PrivacyChoicesButton } from "@agentify/consent";
import type { ScanStatusResponse, Segment } from "@agentify/scanner-contracts";
import { Badge } from "@agentify/ui";
import {
  type CSSProperties,
  type ReactNode,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import { scanStatusIn } from "../lib/api-answers";
import type { ScanFixture } from "../lib/scan-fixtures";
import { SCAN_STATUS_LINES } from "../lib/scan-status";
import { CheckRow } from "./check-row";
import { lazyPart, useHere } from "./lazy-part";
import layout from "./result-layout.module.css";
import styles from "./scan-experience.module.css";
import { ScanFailed } from "./scan-failed";
import { SiteTop } from "./site-chrome";
import { SiteLink } from "./site-link";
import { StatusBadge } from "./status-badge";

// A scan's result, with the share, the prompt and the form for the full
// report, and the browser's observations beside it are not part of the
// page's first load: they are fetched while the scan runs, so the result
// follows its progress at once. Why a scan ended without one is small, and
// is drawn as soon as the status says so.
const ScanTeaser = lazyPart(() => import("./scan-teaser").then((module) => module.ScanTeaser));
const BrowserObservations = lazyPart(() =>
  import("./browser-observations").then((module) => module.BrowserObservations),
);

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

type AccessState = "loading" | "ready" | "missing" | "invalid";

/** The token that reads a scan, kept for the tab's life under the scan's own key. */
const tokenKey = (scanId: string) => `agentify:scan-token:${scanId}`;

/**
 * A private scan, read by the browser from the API with the token the scan's
 * link carried in its fragment: queued, running, ended without a result, or
 * its teaser. A fixture, given outside production, is drawn instead and
 * nothing is asked.
 */
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
  fixture?: ScanFixture | null;
  publicShareEnabled: boolean;
  remediationPromptEnabled: boolean;
  registrationEnabled: boolean;
  scanId: string;
  segment: Segment;
}>) {
  const fixtureName = fixture?.name;
  const [data, setData] = useState<ScanStatusResponse | null>(fixture?.status ?? null);
  const [accessState, setAccessState] = useState<AccessState>(fixtureName ? "ready" : "loading");
  const [requestError, setRequestError] = useState<string | null>(null);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const terminal = data ? ["completed", "partial", "failed"].includes(data.status) : false;
  const underway = data !== null && !terminal;
  const [watchedItRun, setWatchedItRun] = useState(false);

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
    const token = sessionStorage.getItem(tokenKey(scanId));
    if (!token) {
      setAccessState("missing");
      return;
    }
    setAccessState("ready");
    try {
      const response = await fetch(`/api/v1/scans/${encodeURIComponent(scanId)}/status`, {
        cache: "no-store",
        headers: { Authorization: `Bearer ${token}` },
      });
      if (response.status === 401 || response.status === 403) {
        setAccessState("invalid");
        return;
      }
      const status = scanStatusIn(await response.json());
      if (!response.ok || status === null) {
        setRequestError("The scanner returned an invalid or unavailable status response.");
        return;
      }
      setData(status);
      setRequestError(null);
    } catch {
      setRequestError("Live status is temporarily unreachable. We will keep trying.");
    }
  }, [fixtureName, scanId]);

  useEffect(() => {
    if (fixtureName) return;
    captureFragmentToken(scanId);
    void poll();
  }, [fixtureName, poll, scanId]);

  useEffect(() => {
    if (fixtureName || terminal || accessState === "invalid" || accessState === "missing") return;
    const interval = window.setInterval(
      () => void poll(),
      data?.status === "running" ? 1000 : 2000,
    );
    return () => window.clearInterval(interval);
  }, [accessState, data?.status, fixtureName, poll, terminal]);

  useEffect(() => {
    if (!data?.teaser || fixtureName || accessState !== "ready") return;
    window.dispatchEvent(
      new CustomEvent("agentify:analytics-event", {
        detail: { name: "results_viewed", scanId },
      }),
    );
  }, [accessState, data?.teaser, fixtureName, scanId]);

  useEffect(() => {
    if (!underway) return;
    setWatchedItRun(true);
    void ScanTeaser.preload();
    if (browserObservationsEnabled) void BrowserObservations.preload();
  }, [browserObservationsEnabled, underway]);

  const phases = useMemo(() => buildPhases(data, segment), [data, segment]);
  const finished = data !== null && (data.status === "completed" || data.status === "partial");
  // A scan watched running keeps the list it ran with until its result can be
  // drawn, what was open in it included; one opened after it ended shows the
  // finished list while the result's script is on its way.
  const scored = finished && Boolean(data.teaser);
  const resultHere = useHere(ScanTeaser, scored && watchedItRun);
  const holding = scored && watchedItRun && !resultHere;

  const fixtureBanner = fixtureName ? (
    <div className={styles.fixtureBanner}>
      Development fixture: {fixtureName}. This is not live scan evidence.
    </div>
  ) : null;

  return (
    <div className={layout.page}>
      <SiteTop />
      <main className={layout.body}>
        {scored && !holding ? (
          <Suspense
            fallback={
              <ScanCard accessState={accessState} data={data}>
                <ProgressState data={data} elapsedSeconds={elapsedSeconds} phases={phases} />
              </ScanCard>
            }
          >
            <ScanTeaser
              browser={
                browserObservationsEnabled ? (
                  <Suspense fallback={null}>
                    <BrowserObservations scanId={scanId} surface="scan" />
                  </Suspense>
                ) : null
              }
              data={data}
              notice={fixtureBanner}
              publicShareEnabled={publicShareEnabled}
              remediationPromptEnabled={remediationPromptEnabled}
              registrationEnabled={registrationEnabled}
              scanId={scanId}
            />
          </Suspense>
        ) : (
          <ScanCard accessState={accessState} data={data}>
            {fixtureBanner}
            {accessState === "loading" ? <LoadingState /> : null}
            {accessState === "missing" || accessState === "invalid" ? (
              <AccessError invalid={accessState === "invalid"} />
            ) : null}
            {accessState === "ready" && !data ? <LoadingState /> : null}
            {data && (!terminal || holding) ? (
              <ProgressState data={data} elapsedSeconds={elapsedSeconds} phases={phases} />
            ) : null}
            {data?.status === "failed" ? (
              <ScanFailed
                blocked={data.blocked === true}
                checks={data.checks}
                onRetry={() => window.location.assign("/")}
              />
            ) : null}
            {finished && !data.teaser ? (
              <ScanFailed blocked={false} checks={data.checks} onRetry={() => void poll()} />
            ) : null}
            {requestError ? (
              <div aria-live="polite" className={styles.pollNotice}>
                {requestError}
              </div>
            ) : null}
          </ScanCard>
        )}
      </main>
      <nav aria-label="Scan help" className={layout.foot}>
        <a href="/docs/scanner">Scanner identity</a>
        <a href="/docs/scanner/methodology">Methodology</a>
        <SiteLink to="/privacy">Privacy</SiteLink>
        <PrivacyChoicesButton />
      </nav>
    </div>
  );
}

/** A scan without a result to show yet, or without one at all, in a sheet of its own. */
function ScanCard({
  accessState,
  children,
  data,
}: Readonly<{
  accessState: AccessState;
  children: ReactNode;
  data: ScanStatusResponse | null;
}>) {
  return (
    <div className={`${layout.sheet} ${layout.single}`}>
      <section>
        <header className={styles.scanHeader}>
          <p>
            <b>{data?.target_host ?? "Private website diagnostic"}</b>
            <span>{scanStatusLine(data?.status, accessState)}</span>
          </p>
          <ScanStateBadge accessState={accessState} status={data?.status} />
        </header>
        {children}
      </section>
    </div>
  );
}

type Phase = Readonly<{
  label: string;
  status: "done" | "active" | "pending" | "unavailable";
}>;

function buildPhases(data: ScanStatusResponse | null, segment: Segment): readonly Phase[] {
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
  if (data.status === "completed" || data.status === "partial") {
    return labels.map((label) => ({ label, status: "done" }));
  }

  const terminalChecks = data.checks.filter((check) =>
    ["pass", "partial", "fail", "unavailable", "not_applicable"].includes(check.status),
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
    status: index < phaseIndex ? "done" : index === phaseIndex ? "active" : "pending",
  }));
}

const PHASE_WORDS: Record<Phase["status"], string> = {
  done: "Done",
  active: "Reading…",
  pending: "Pending",
  unavailable: "Unavailable",
};

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
        Scan {data.status}. {data.progress.completed} of {data.progress.total} checks have a
        terminal result.
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
            <span>{PHASE_WORDS[phase.status]}</span>
          </li>
        ))}
      </ol>
      <p className={styles.phaseCount}>
        <span>
          {data.status === "queued" || data.status === "accepted"
            ? "Waiting for scanner capacity"
            : `${data.progress.completed} of ${data.progress.total} checks reported`}
        </span>
        <span>{elapsedSeconds}s · usually under 60 s</span>
      </p>
      {data.checks.length > 0 ? (
        <details className={styles.checkDetails}>
          <summary>Live check details</summary>
          <div>
            {data.checks.map((check) => (
              <CheckRow
                key={check.id}
                state={<StatusBadge status={check.status} />}
                title={labelFor(check.label_code)}
              />
            ))}
          </div>
        </details>
      ) : null}
    </div>
  );
}

function AccessError({ invalid }: Readonly<{ invalid: boolean }>) {
  return (
    <div className={`${layout.message} ${styles.state}`}>
      <h1>
        {invalid ? "This scan link is no longer valid" : "Open the original private scan link"}
      </h1>
      <p>Scan progress is private.</p>
      <SiteLink className="button button-primary" to="/">
        Start a new scan
      </SiteLink>
    </div>
  );
}

function LoadingState() {
  return (
    <div aria-live="polite" className={styles.loading}>
      Reading the scan state…
    </div>
  );
}

function ScanStateBadge({
  accessState,
  status,
}: Readonly<{
  accessState: AccessState;
  status?: ScanStatusResponse["status"];
}>) {
  if (accessState === "missing" || accessState === "invalid")
    return <StatusBadge status="unavailable" />;
  // A scan that ended without a result found no fault: "Fail" is a check's
  // verdict on something it could read.
  if (status === "failed") return <Badge tone="quiet">No result</Badge>;
  if (status === "completed") return <StatusBadge status="complete" />;
  if (status === "partial") return <StatusBadge status="partial" />;
  return <StatusBadge status="running" />;
}

function scanStatusLine(
  status: ScanStatusResponse["status"] | undefined,
  accessState: AccessState,
) {
  if (accessState === "missing" || accessState === "invalid") return "Private access required";
  if (!status) return "Reading scan state…";
  return SCAN_STATUS_LINES[status];
}

function captureFragmentToken(scanId: string) {
  const fragment = new URLSearchParams(window.location.hash.slice(1));
  const token = fragment.get("access_token");
  if (!token) return;
  sessionStorage.setItem(tokenKey(scanId), token);
  // The router's own entry state is kept, so going back and forth still works.
  window.history.replaceState(
    window.history.state,
    "",
    `${window.location.pathname}${window.location.search}`,
  );
}

function labelFor(labelCode: string) {
  return CHECK_LABELS[labelCode as keyof typeof CHECK_LABELS] ?? labelCode.replaceAll("_", " ");
}
