import { PrivacyChoicesButton } from "@agentify/consent";
import type { ReportView } from "../lib/report-view";
import { BrowserObservations } from "./browser-observations";
import { CardSignal } from "./card-signal";
import { CopyRemediationPrompt } from "./copy-remediation-prompt";
import { ReportActionPanel } from "./report-action-panel";
import { ReportBenchmark } from "./report-benchmark";
import { ReportDashboardControl } from "./report-dashboard-control";
import { ReportTop } from "./report-locked";
import styles from "./report-page.module.css";
import { RobotsNotice } from "./robots-notice";
import { SiteLink } from "./site-link";
import { StatusBadge } from "./status-badge";

/** A full report, for the person it is filed under, drawn from what the server composed. */
export function ReportPage({ view }: Readonly<{ view: ReportView }>) {
  return (
    <main className={styles.page} data-agentify-results-viewed-scan={view.scanId}>
      <ReportTop />
      <header className={styles.hero}>
        <div>
          <span className="eyebrow">Private diagnostic · {view.host}</span>
          <h1>{view.levelLabel}</h1>
        </div>
        <strong>
          {view.score ?? "—"}
          <small>/100</small>
        </strong>
        <p>Coverage {view.coveragePercent}% · diagnostic, not certification</p>
        <ReportBenchmark benchmark={view.benchmark} />
        {view.level === "callable_ready" ? (
          <p>
            Callable-ready describes public discovery metadata. Agentify did not invoke tools or
            verify authenticated actions.
          </p>
        ) : null}
      </header>
      <ReportActionPanel
        aiPrompt={view.actions.aiPrompt}
        devBrief={view.actions.devBrief}
        downloadUrl={view.actions.downloadUrl}
        preview={{ hostLabel: view.host, level: view.level, score: view.score }}
        promptEnabled={view.actions.promptEnabled}
        scanId={view.scanId}
        shareEnabled={view.actions.shareEnabled}
      />
      <section className={styles.dashboard}>
        <h2>Selling to agents</h2>
        <p>
          If what you sell can be sent a second time without loss, an access, a key, a link, a
          subscription, the same address opens a seller dashboard: once it has a seller name and a
          payout wallet, your engineer publishes the cards and takes orders in the test channel, and
          selling live also needs our switch. If not, this report is the whole result, and you can
          scan the site again whenever it changes.
        </p>
        <ReportDashboardControl />
      </section>
      <section className={styles.checks}>
        <div className={styles.sectionHeading}>
          <h2>All 18 checks</h2>
        </div>
        <RobotsNotice checks={view.robots} className={styles.scopeNote} />
        {view.groups.map((group) => (
          <section className={styles.checkGroup} key={group.title}>
            <h3>{group.title}</h3>
            {group.checks.map((check) => (
              <details className={styles.check} key={check.id} open={check.open}>
                <summary>
                  <span className="mono">{String(check.id).padStart(2, "0")}</span>
                  <strong>{check.label}</strong>
                  <StatusBadge status={check.status} />
                </summary>
                <div>
                  <p>{check.summary}</p>
                  <p>{check.impact}</p>
                  {check.scopeNote ? (
                    <p className={styles.scopeNote}>
                      {check.scopeNote}{" "}
                      <a href="/docs/scanner/methodology#limits">Read the scope.</a>
                    </p>
                  ) : null}
                  {check.fix ? (
                    <p>
                      <strong>Fix:</strong> {check.fix}
                    </p>
                  ) : null}
                  {check.evidence.length ? (
                    <dl>
                      {check.evidence.map(([label, value]) => (
                        <div key={label}>
                          <dt>{label}</dt>
                          <dd>{value}</dd>
                        </div>
                      ))}
                    </dl>
                  ) : null}
                  {check.prompt ? (
                    <div className={styles.copyFix}>
                      <CopyRemediationPrompt
                        label="Copy this fix"
                        prompt={check.prompt}
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
      {view.browserObservation ? (
        <div className={styles.browserSection}>
          <BrowserObservations
            fixPrompts={view.browserFixPrompts}
            initialData={view.browserObservation}
            scanId={view.scanId}
            surface="report"
          />
        </div>
      ) : null}
      {view.cardSignal ? (
        <CardSignal
          adapter={view.cardSignal.adapter}
          enabled
          initialSignal={view.cardSignal.initialSignal}
          publishableKey={view.cardSignal.publishableKey}
          scanId={view.scanId}
        />
      ) : null}
      <nav className={styles.account}>
        <SiteLink to="/email/unsubscribe">Email preferences</SiteLink>
        <SiteLink to="/data-request">Access or deletion request</SiteLink>
        <PrivacyChoicesButton />
      </nav>
    </main>
  );
}
