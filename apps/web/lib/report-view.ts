/**
 * What the full report page shows, composed on the server from the report,
 * the browser's observations and the site's switches: every sentence of every
 * check and every prompt is written here, so the page's own script carries
 * none of the copy or the prompt builder, and the page can be drawn from an
 * example report as well as a real one.
 */

import {
  canonicalCheckLabel,
  canonicalFixCopy,
  canonicalImpactCopy,
  canonicalSummaryCopy,
} from "@agentify/remediation";
import type {
  BrowserObservationStatusResponse,
  CheckStatus,
  DiagnosticLevel,
  ReportResponse,
  RobotsReason,
} from "@agentify/scanner-contracts";

import { isActionableBrowserFinding } from "./browser-observation-ui";
import type { CardSignalState } from "./card-signal-ui";
import { buildBrowserFixPrompt, buildCanonicalFixPrompt, buildFixPrompts } from "./fix-prompts";
import { scanDay } from "./levels";

type ReportCheckView = Readonly<{
  id: number;
  label: string;
  status: CheckStatus;
  summary: string;
  /** What the result means for the site, or why the check was not assessed. */
  impact: string;
  scopeNote: string | null;
  fix: string | null;
  evidence: readonly (readonly [label: string, value: string])[];
  /** The prompt that fixes this check alone, where prompts are on and there is something to fix. */
  prompt: string | null;
  /** The first failing check is shown open. */
  open: boolean;
}>;

export type ReportCardSignal = Readonly<{
  adapter: "local" | "stripe";
  publishableKey: string | null;
  initialSignal?: Readonly<{
    signalId: string;
    status: CardSignalState;
    clientSecret: string | null;
  }>;
}>;

export type ReportView = Readonly<{
  scanId: string;
  host: string;
  level: DiagnosticLevel;
  score: number | null;
  coverage: number;
  /** The day the scan was made, in UTC, or null where its time is not a date. */
  scannedDay: string | null;
  benchmark: ReportResponse["benchmark"];
  actions: Readonly<{
    aiPrompt: string;
    devBrief: string;
    downloadUrl: string;
    promptEnabled: boolean;
    shareEnabled: boolean;
  }>;
  robots: readonly Readonly<{ id: number; robots: RobotsReason | null }>[];
  /** How many checks are in each state, failures first; a state no check is in is left out. */
  tally: readonly Readonly<{ status: CheckStatus; count: number }>[];
  groups: readonly Readonly<{ title: string; checks: readonly ReportCheckView[] }>[];
  browserObservation: BrowserObservationStatusResponse | null;
  /** The prompt that fixes each actionable browser finding, by its id, where prompts are on. */
  browserFixPrompts: Readonly<Record<string, string>>;
  /** The optional card signal, where it is on or this report's owner already gave one. */
  cardSignal: ReportCardSignal | null;
}>;

const REPORT_GROUPS: readonly Readonly<{ title: string; ids: readonly number[] }>[] = [
  { title: "Discovery", ids: [1, 2, 3, 4, 8, 9, 17, 18] },
  { title: "Content", ids: [5, 6, 7, 12] },
  { title: "Agent access", ids: [11, 13, 14] },
  { title: "Commerce", ids: [10, 15] },
  { title: "Informational", ids: [16] },
];

const TALLY_ORDER: readonly CheckStatus[] = [
  "fail",
  "partial",
  "unavailable",
  "not_applicable",
  "pending",
  "running",
  "pass",
];

const SCOPE_NOTES: Readonly<Record<number, string>> = {
  9: "The MCP server-card location is an experimental discovery convention; presence does not verify any tool.",
  10: "A UCP declaration does not verify catalog freshness, checkout rules, or a transaction.",
  11: "Public OAuth metadata is checked without logging in or testing delegated permissions.",
  17: "An A2A card is informational unless a real A2A agent is intentionally operated.",
};

function formatCode(value: string): string {
  return value.replaceAll("_", " ").replace(/\b\w/g, (character) => character.toUpperCase());
}

function impactOf(check: ReportResponse["checks"][number]): string {
  if (check.robots === "disallowed")
    return "Not assessed: your robots.txt keeps the scanner out of what this check reads, and the scanner follows it. No defect is inferred.";
  if (check.robots === "unassessed")
    return "Not assessed: robots.txt could not be read or decided for what this check reads, so the scanner did not read it. No defect is inferred.";
  if (check.status === "unavailable")
    return "This public surface could not be assessed, so no defect is inferred.";
  return canonicalImpactCopy(check.user_impact_code);
}

export function reportView(
  report: ReportResponse,
  browserObservation: BrowserObservationStatusResponse | undefined,
  site: Readonly<{
    brand: string;
    promptEnabled: boolean;
    shareEnabled: boolean;
    cardSignal: ReportCardSignal | null;
  }>,
): ReportView {
  const { aiPrompt, devBrief } = buildFixPrompts(report, site.brand, browserObservation);
  const firstFailId = report.checks.find((check) => check.status === "fail")?.id;
  const checkView = (check: ReportResponse["checks"][number]): ReportCheckView => ({
    id: check.id,
    label: canonicalCheckLabel(check.label_code),
    status: check.status,
    summary: canonicalSummaryCopy(check.summary_code),
    impact: impactOf(check),
    scopeNote: SCOPE_NOTES[check.id] ?? null,
    fix: check.status !== "unavailable" && check.fix_code ? canonicalFixCopy(check.fix_code) : null,
    evidence: Object.entries(check.evidence).map(([key, value]) => [
      formatCode(key),
      Array.isArray(value) ? value.join(", ") : String(value),
    ]),
    prompt:
      site.promptEnabled && (check.status === "fail" || check.status === "partial")
        ? buildCanonicalFixPrompt(report, check, site.brand)
        : null,
    open: check.id === firstFailId,
  });
  return {
    scanId: report.scan_id,
    host: report.host,
    level: report.level,
    score: report.score,
    coverage: report.coverage,
    scannedDay: scanDay(report.scanned_at),
    benchmark: report.benchmark,
    actions: {
      aiPrompt,
      devBrief,
      downloadUrl: `/api/v1/reports/${encodeURIComponent(report.scan_id)}/remediation-prompt/download`,
      promptEnabled: site.promptEnabled,
      shareEnabled: site.shareEnabled,
    },
    robots: report.checks.map(({ id, robots }) => ({ id, robots })),
    tally: TALLY_ORDER.flatMap((status) => {
      const count = report.checks.filter((check) => check.status === status).length;
      return count > 0 ? [{ status, count }] : [];
    }),
    groups: REPORT_GROUPS.map((group) => ({
      title: group.title,
      checks: report.checks.filter((check) => group.ids.includes(check.id)).map(checkView),
    })),
    browserObservation: browserObservation ?? null,
    browserFixPrompts: site.promptEnabled
      ? Object.fromEntries(
          (browserObservation?.findings ?? [])
            .filter(isActionableBrowserFinding)
            .map((finding) => [
              finding.id,
              buildBrowserFixPrompt(report.host, finding, site.brand),
            ]),
        )
      : {},
    cardSignal: site.cardSignal,
  };
}
