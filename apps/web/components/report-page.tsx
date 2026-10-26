import type { ReportView } from "../lib/report-view";
import { BrowserObservations } from "./browser-observations";
import { CheckRow } from "./check-row";
import { CopyRemediationPrompt } from "./copy-remediation-prompt";
import { ReportActionPanel } from "./report-action-panel";
import { benchmarkCaption } from "./report-benchmark";
import { ReportDashboardControl } from "./report-dashboard-control";
import styles from "./report-page.module.css";
import { ResultHead } from "./result-head";
import layout from "./result-layout.module.css";
import { RobotsNotice } from "./robots-notice";
import { SiteFooter, SiteHeader } from "./site-chrome";
import { SiteLink } from "./site-link";
import { StatusBadge } from "./status-badge";

/** A full report, for the person it is filed under, drawn from what the server composed. */
export function ReportPage({ view }: Readonly<{ view: ReportView }>) {
  return (
    <div className={layout.page}>
      <SiteHeader current="scanner" />
      <main className={layout.body} id="main" data-agentify-results-viewed-scan={view.scanId}>
        <div className={layout.columns}>
          <div className={layout.sheet}>
            <section>
              <ResultHead
                caption={benchmarkCaption(view.benchmark)}
                coverage={view.coverage}
                host={view.host}
                level={view.level}
                line={
                  view.scannedDay ? `Private report · Scanned ${view.scannedDay}` : "Private report"
                }
                score={view.score}
              />
              <ReportActionPanel
                aiPrompt={view.actions.aiPrompt}
                devBrief={view.actions.devBrief}
                downloadUrl={view.actions.downloadUrl}
                preview={{ hostLabel: view.host, level: view.level, score: view.score }}
                promptEnabled={view.actions.promptEnabled}
                scanId={view.scanId}
                shareEnabled={view.actions.shareEnabled}
              />
            </section>
            <section>
              <div className={layout.sectionHead}>
                <h2>All 18 checks</h2>
              </div>
              <ul aria-label="Checks by state" className={styles.tally}>
                {view.tally.map(({ status, count }) => (
                  <li key={status}>
                    <StatusBadge count={count} status={status} />
                  </li>
                ))}
              </ul>
              <RobotsNotice checks={view.robots} className={layout.note} />
              {view.groups.map((group) => (
                <div className={styles.group} key={group.title}>
                  <h3>{group.title}</h3>
                  {group.checks.map((check) => (
                    <CheckRow
                      detail={
                        <>
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
                            <dl className={styles.evidence}>
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
                        </>
                      }
                      fold={check.open ? "open" : "closed"}
                      key={check.id}
                      number={check.id}
                      state={<StatusBadge status={check.status} />}
                      title={check.label}
                    />
                  ))}
                </div>
              ))}
            </section>
            {view.browserObservation ? (
              <BrowserObservations
                fixPrompts={view.browserFixPrompts}
                initialData={view.browserObservation}
                scanId={view.scanId}
                surface="report"
              />
            ) : null}
          </div>
          <div className={layout.aside}>
            <section className={`${layout.panel} ${layout.tinted}`}>
              <h2>Selling to agents</h2>
              <p className={layout.lead}>
                If what you sell can be delivered again without loss — an access, a key, a link, a
                subscription — the same email opens a seller dashboard. Selling live also needs our
                approval. If not, this report is the whole result.
              </p>
              <ReportDashboardControl />
            </section>
          </div>
        </div>
      </main>
      <SiteFooter>
        <SiteLink to="/email/unsubscribe">Email preferences</SiteLink>
      </SiteFooter>
    </div>
  );
}
