import type { Metadata } from "next";
import { cookies } from "next/headers";
import Link from "next/link";

import { Brand } from "../../../components/brand";
import { BrowserObservations } from "../../../components/browser-observations";
import { CardSignal } from "../../../components/card-signal";
import { CopyRemediationPrompt } from "../../../components/copy-remediation-prompt";
import { PrivacyChoicesButton } from "../../../components/privacy-choices-button";
import { ReportActionPanel } from "../../../components/report-action-panel";
import { ReportBenchmark } from "../../../components/report-benchmark";
import { ReportCabinetControl } from "../../../components/report-cabinet-control";
import { StatusBadge } from "../../../components/status-badge";
import { getPublicAppConfig } from "../../../lib/app-config";
import {
  buildCanonicalFixPrompt,
  buildFixPrompts,
} from "../../../lib/fix-prompts";
import { REPORT_SESSION_COOKIE } from "../../../lib/server/auth";
import { getServerConfig } from "../../../lib/server/config";
import {
  getFullBrowserObservation,
  getFullReport,
  getReportOwnerEmail,
} from "../../../lib/server/reporting";
import { getCardSignalPublicConfig } from "../../../lib/server/stripe-card-signal-config";
import { getOwnedCardSignalForReport } from "../../../lib/server/stripe-card-signal";
import styles from "./report.module.css";
import {
  canonicalCheckLabel,
  canonicalFixCopy,
  canonicalImpactCopy,
  canonicalSummaryCopy,
} from "@agentify/remediation";

export const metadata: Metadata = {
  title: "Private diagnostic report",
  robots: { index: false, follow: false },
  referrer: "strict-origin",
};

export default async function ReportPage({
  params,
}: {
  params: Promise<{ scanId: string }>;
}) {
  const { scanId } = await params;
  const cookieStore = await cookies();
  const sessionToken = cookieStore.get(REPORT_SESSION_COOKIE)?.value;
  const report = await getFullReport(scanId, sessionToken);
  if (!report) {
    return (
      <main className={styles.page}>
        <Brand />
        <section className={styles.locked}>
          <h1>Private report access required</h1>
          <p>
            Open the one-time verification link sent after this scan. A scan
            token alone cannot open the full report.
          </p>
          <Link
            className="button button-primary"
            href="/auth/callback?recover=1"
          >
            Recover report access
          </Link>
        </section>
      </main>
    );
  }
  const serverConfig = getServerConfig();
  const browserObservation = await getFullBrowserObservation(
    scanId,
    sessionToken,
  );
  const cardSignal = getCardSignalPublicConfig();
  const initialCardSignal = await getOwnedCardSignalForReport(
    scanId,
    sessionToken,
  );
  const publicConfig = getPublicAppConfig();
  const reportOwnerEmail = await getReportOwnerEmail(scanId, sessionToken);
  const { aiPrompt, devBrief } = buildFixPrompts(
    report,
    publicConfig.displayBrand,
    browserObservation,
  );
  const firstFailId = report.checks.find(
    (check) => check.status === "fail",
  )?.id;
  return (
    <main
      className={styles.page}
      data-agentify-results-viewed-scan={report.scan_id}
    >
      <Brand />
      <header className={styles.hero}>
        <div>
          <span className="eyebrow">Private diagnostic · {report.host}</span>
          <h1>{formatCode(report.level)}</h1>
        </div>
        <strong>
          {report.score ?? "—"}
          <small>/100</small>
        </strong>
        <p>
          Coverage {Math.round(report.coverage * 100)}% · diagnostic, not
          certification
        </p>
        <ReportBenchmark benchmark={report.benchmark} />
        {report.level === "callable_ready" ? (
          <p>
            Callable-ready describes public discovery metadata. Agentify did not
            invoke tools or verify authenticated actions.
          </p>
        ) : null}
      </header>
      <ReportActionPanel
        aiPrompt={aiPrompt}
        devBrief={devBrief}
        downloadUrl={`/api/v1/reports/${encodeURIComponent(report.scan_id)}/remediation-prompt/download`}
        preview={{
          hostLabel: report.host,
          level: report.level,
          score: report.score,
        }}
        promptEnabled={serverConfig.REMEDIATION_PROMPT_ENABLED}
        scanId={report.scan_id}
        shareEnabled={serverConfig.PUBLIC_SHARE_ENABLED}
      />
      {reportOwnerEmail ? (
        <section>
          <h2>Selling to agents</h2>
          <p>
            If what you sell can be sent a second time without loss, an access,
            a key, a link, a subscription, the same address opens a merchant
            cabinet: your engineer publishes the cards and takes orders in the
            test channel, and selling live needs a seller name, a payout wallet
            and our switch. If not, this report is the whole result, and you can
            scan the site again whenever it changes.
          </p>
          <ReportCabinetControl
            email={reportOwnerEmail}
            reportPath={`/report/${encodeURIComponent(report.scan_id)}`}
          />
        </section>
      ) : null}
      <section className={styles.checks}>
        <div className={styles.sectionHeading}>
          <span className="eyebrow">Canonical rubric</span>
          <h2>All 18 checks</h2>
        </div>
        {REPORT_GROUPS.map((group) => (
          <section className={styles.checkGroup} key={group.title}>
            <h3>{group.title}</h3>
            {report.checks
              .filter((check) => group.ids.includes(check.id))
              .map((check) => (
                <details
                  className={styles.check}
                  key={check.id}
                  open={check.id === firstFailId}
                >
                  <summary>
                    <span className="mono">
                      {String(check.id).padStart(2, "0")}
                    </span>
                    <strong>{canonicalCheckLabel(check.label_code)}</strong>
                    <StatusBadge status={check.status} />
                  </summary>
                  <div>
                    <p>
                      <strong>What we found:</strong>{" "}
                      {canonicalSummaryCopy(check.summary_code)}
                    </p>
                    <p>
                      <strong>Why it matters:</strong>{" "}
                      {check.status === "unavailable"
                        ? "This public surface could not be assessed, so no defect is inferred."
                        : canonicalImpactCopy(check.user_impact_code)}
                    </p>
                    {checkScopeNote(check.id) ? (
                      <p className={styles.scopeNote}>
                        {checkScopeNote(check.id)}{" "}
                        <Link href="/methodology#limits">Read the scope.</Link>
                      </p>
                    ) : null}
                    {check.status !== "unavailable" && check.fix_code ? (
                      <p>
                        <strong>How to improve:</strong>{" "}
                        {canonicalFixCopy(check.fix_code)}
                      </p>
                    ) : null}
                    {Object.keys(check.evidence).length ? (
                      <dl>
                        {Object.entries(check.evidence).map(([key, value]) => (
                          <div key={key}>
                            <dt>{formatCode(key)}</dt>
                            <dd>
                              {Array.isArray(value)
                                ? value.join(", ")
                                : String(value)}
                            </dd>
                          </div>
                        ))}
                      </dl>
                    ) : null}
                    {serverConfig.REMEDIATION_PROMPT_ENABLED &&
                    (check.status === "fail" || check.status === "partial") ? (
                      <div className={styles.copyFix}>
                        <CopyRemediationPrompt
                          label="Copy this fix"
                          prompt={buildCanonicalFixPrompt(
                            report,
                            check,
                            publicConfig.displayBrand,
                          )}
                          secondary
                        />
                      </div>
                    ) : null}
                  </div>
                </details>
              ))}
          </section>
        ))}
      </section>
      {browserObservation ? (
        <div className={styles.browserSection}>
          <BrowserObservations
            host={report.host}
            initialData={browserObservation}
            remediationPromptEnabled={serverConfig.REMEDIATION_PROMPT_ENABLED}
            scanId={scanId}
            surface="report"
          />
        </div>
      ) : null}
      {cardSignal.enabled || initialCardSignal ? (
        <CardSignal
          adapter={initialCardSignal?.adapter ?? cardSignal.adapter}
          enabled
          initialSignal={initialCardSignal}
          publishableKey={cardSignal.publishableKey}
          scanId={report.scan_id}
        />
      ) : null}
      <nav className={styles.account}>
        <Link href="/email/unsubscribe">Email preferences</Link>
        <Link href="/data-request">Access or deletion request</Link>
        <PrivacyChoicesButton />
      </nav>
    </main>
  );
}

function formatCode(value: string) {
  if (value === "callable_ready") return "Callable-ready";
  return value
    .replaceAll("_", " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

const REPORT_GROUPS: readonly Readonly<{
  title: string;
  ids: readonly number[];
}>[] = [
  { title: "Discovery", ids: [1, 2, 3, 4, 8, 9, 17, 18] },
  { title: "Content", ids: [5, 6, 7, 12] },
  { title: "Agent access", ids: [11, 13, 14] },
  { title: "Commerce", ids: [10, 15] },
  { title: "Informational", ids: [16] },
];

function checkScopeNote(id: number): string | undefined {
  if (id === 9)
    return "The MCP server-card location is an experimental discovery convention; presence does not verify any tool.";
  if (id === 10)
    return "A UCP declaration does not verify catalog freshness, checkout rules, or a transaction.";
  if (id === 11)
    return "Public OAuth metadata is checked without logging in or testing delegated permissions.";
  if (id === 17)
    return "An A2A card is informational unless a real A2A agent is intentionally operated.";
  return undefined;
}
