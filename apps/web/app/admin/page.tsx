/**
 * The operator's dashboard: read-only numbers about the scanner, for a session
 * whose account carries the operator flag (ADR-0026 §6).
 *
 * Nothing stands in front of it. The page asks the cabinet on every request,
 * and anybody it does not confirm, everybody while the cabinet cannot say
 * included, gets the site's 404 page. The refusal happens in the metadata as
 * well as in the page: metadata is resolved on its own, and a title resolved
 * for a visitor who is then refused would tell them what this page is.
 */

import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { cache } from "react";

import { Brand } from "../../components/brand";
import { isOperator } from "../../lib/server/operator";
import {
  getOperatorDashboard,
  type OperatorDailyFunnel,
} from "../../lib/server/operator-dashboard";

import styles from "./admin.module.css";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/** Whether this request's session is an operator's, asked once per request. */
const operatorVisiting = cache(async () => await isOperator((await headers()).get("cookie")));

export async function generateMetadata(): Promise<Metadata> {
  if (!(await operatorVisiting())) notFound();
  return { title: "Operator dashboard", robots: { index: false, follow: false } };
}

const number = new Intl.NumberFormat("en-US");
const percent = new Intl.NumberFormat("en-US", {
  style: "percent",
  maximumFractionDigits: 1,
});
const money = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 4,
});
const dateTime = new Intl.DateTimeFormat("en-GB", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "UTC",
});

const ratio = (value: number, denominator: number) =>
  denominator > 0 ? percent.format(value / denominator) : "—";

function Metric({ label, value, note }: Readonly<{ label: string; value: string; note: string }>) {
  return (
    <article className={styles.metric}>
      <p>{label}</p>
      <strong>{value}</strong>
      <span>{note}</span>
    </article>
  );
}

function DailyBars({ rows }: Readonly<{ rows: OperatorDailyFunnel[] }>) {
  const max = Math.max(1, ...rows.map((row) => row.landingViews));
  return (
    <div className={styles.bars} aria-label="Daily traffic and scan volume">
      {rows.map((row) => (
        <div className={styles.barColumn} key={row.day} title={row.day}>
          <div className={styles.barTrack}>
            <span
              className={styles.landingBar}
              style={{
                height: `${Math.max(3, (row.landingViews / max) * 100)}%`,
              }}
            />
            <span
              className={styles.scanBar}
              style={{ height: `${Math.max(0, (row.scans / max) * 100)}%` }}
            />
          </div>
          <span>{row.day.slice(8)}</span>
        </div>
      ))}
    </div>
  );
}

const statusClass = (status: string | null) => {
  if (status === "pass" || status === "completed") return styles.good;
  if (status === "partial" || status === "running") return styles.warn;
  if (status === "fail" || status === "failed" || status === "blocked") return styles.bad;
  return styles.neutral;
};

export default async function AdminPage() {
  if (!(await operatorVisiting())) notFound();
  const data = await getOperatorDashboard();
  const { overview, selfScan } = data;

  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <Brand />
        <div>
          <span className={styles.liveDot} aria-hidden="true" />
          Live operator view · refreshed {dateTime.format(new Date(data.generatedAt))} UTC
        </div>
      </header>

      <section className={styles.hero}>
        <p className="eyebrow">Private · read-only</p>
        <h1>Agentify operating dashboard</h1>
        <p>
          Traffic, conversion, scanned sites, scanner health, and the latest self-check. Contact
          details and raw evidence are deliberately absent.
        </p>
        <a className="button button-secondary" href="/admin">
          Refresh data
        </a>
      </section>

      <section aria-labelledby="overview-title">
        <div className={styles.sectionHeading}>
          <div>
            <p className="eyebrow">Last 30 days</p>
            <h2 id="overview-title">Acquisition overview</h2>
          </div>
          <p>{number.format(overview.visitorsTotal)} visitors all time</p>
        </div>
        <div className={styles.metrics}>
          <Metric
            label="Visitors"
            value={number.format(overview.visitors30d)}
            note={`${number.format(overview.landingViews30d)} landing views`}
          />
          <Metric
            label="Scans"
            value={number.format(overview.scans30d)}
            note={`${ratio(overview.scans30d, overview.landingViews30d)} of landing views`}
          />
          <Metric
            label="Sites checked"
            value={number.format(overview.uniqueSites30d)}
            note={`${number.format(overview.completedScans30d)} completed or partial`}
          />
          <Metric
            label="Verified registrations"
            value={number.format(overview.verifiedRegistrations30d)}
            note={`${ratio(overview.verifiedRegistrations30d, overview.scans30d)} of scans`}
          />
          <Metric
            label="Reports shared"
            value={number.format(overview.shares30d)}
            note={`${ratio(overview.shares30d, overview.completedScans30d)} of finished scans`}
          />
          <Metric
            label="Scans all time"
            value={number.format(overview.scansTotal)}
            note="Accepted scan jobs"
          />
        </div>
      </section>

      <section className={styles.panel} aria-labelledby="trend-title">
        <div className={styles.sectionHeading}>
          <div>
            <p className="eyebrow">30-day trend</p>
            <h2 id="trend-title">Landing views vs scans</h2>
          </div>
          <div className={styles.legend}>
            <span>
              <i className={styles.legendLanding} />
              Landing views
            </span>
            <span>
              <i className={styles.legendScan} />
              Scans
            </span>
          </div>
        </div>
        <DailyBars rows={data.daily} />
      </section>

      <div className={styles.twoColumn}>
        <section className={styles.panel} aria-labelledby="self-title">
          <p className="eyebrow">Agentify checks Agentify</p>
          <h2 id="self-title">Can agents read our site?</h2>
          {selfScan ? (
            <>
              <div className={styles.selfScore}>
                <strong>{selfScan.score ?? "—"}</strong>
                <span>/ 100 · {selfScan.level?.replaceAll("_", " ") ?? selfScan.status}</span>
              </div>
              <dl className={styles.definitionList}>
                <div>
                  <dt>Substantive initial HTML</dt>
                  <dd className={statusClass(selfScan.substantiveHtmlStatus)}>
                    {selfScan.substantiveHtmlStatus ?? "not assessed"}
                  </dd>
                </div>
                <div>
                  <dt>ChatGPT-User / Claude-User compatibility</dt>
                  <dd className={statusClass(selfScan.agentUserAgentStatus)}>
                    {selfScan.agentUserAgentStatus ?? "not assessed"}
                  </dd>
                </div>
                <div>
                  <dt>Passive browser observation</dt>
                  <dd className={statusClass(selfScan.browserStatus)}>
                    {selfScan.browserStatus ?? "not sampled"}
                  </dd>
                </div>
                <div>
                  <dt>Coverage</dt>
                  <dd>{selfScan.coverage === null ? "—" : percent.format(selfScan.coverage)}</dd>
                </div>
              </dl>
              <p className={styles.caveat}>
                A pass proves public HTTP compatibility at scan time. It does not prove that a model
                indexed, cited, or recommended Agentify.
              </p>
            </>
          ) : (
            <p>No Agentify self-scan has completed yet.</p>
          )}
        </section>

        <section className={styles.panel} aria-labelledby="protection-title">
          <p className="eyebrow">Budget protection</p>
          <h2 id="protection-title">Abuse controls</h2>
          <div className={styles.protectionState}>
            <span className={data.turnstileEnforced ? styles.good : styles.warn}>
              {data.turnstileEnforced ? "Turnstile enforced" : "Turnstile keys pending"}
            </span>
          </div>
          <dl className={styles.definitionList}>
            <div>
              <dt>Free anonymous scans</dt>
              <dd>3 / IP / rolling hour</dd>
            </div>
            <div>
              <dt>Hard IP ceiling</dt>
              <dd>10 / rolling hour</dd>
            </div>
            <div>
              <dt>Hard target ceiling</dt>
              <dd>10 / site / day</dd>
            </div>
            <div>
              <dt>Accepted requests · 24h</dt>
              <dd>{number.format(overview.acceptedRequests24h)}</dd>
            </div>
            <div>
              <dt>Verified challenges · rolling hour</dt>
              <dd>{data.turnstileEnforced ? number.format(overview.challengePasses1h) : "—"}</dd>
            </div>
            <div>
              <dt>Browser cost · today</dt>
              <dd>{money.format(overview.browserUsageUsdToday)}</dd>
            </div>
          </dl>
          <p className={styles.caveat}>
            Hard ceilings remain active even when the third-party challenge is unavailable, so one
            source cannot drain the browser budget.
          </p>
        </section>
      </div>

      <section className={styles.panel} aria-labelledby="scans-title">
        <div className={styles.sectionHeading}>
          <div>
            <p className="eyebrow">Latest 50</p>
            <h2 id="scans-title">Recently checked sites</h2>
          </div>
          <p>Hostnames only · no submitted query strings</p>
        </div>
        <div
          aria-label="Recently checked sites table"
          className={styles.tableWrap}
          role="region"
          tabIndex={0}
        >
          <table>
            <thead>
              <tr>
                <th>Site</th>
                <th>Segment</th>
                <th>Status</th>
                <th>Score</th>
                <th>Coverage</th>
                <th>Browser</th>
                <th>Duration</th>
                <th>Accepted</th>
              </tr>
            </thead>
            <tbody>
              {data.recentScans.map((scan) => (
                <tr key={scan.scanId}>
                  <td>
                    <strong>{scan.targetHost}</strong>
                    {scan.cacheHit ? <small> cache</small> : null}
                  </td>
                  <td>{scan.segment}</td>
                  <td>
                    <span className={statusClass(scan.status)}>{scan.status}</span>
                  </td>
                  <td>{scan.score ?? "—"}</td>
                  <td>{scan.coverage === null ? "—" : percent.format(scan.coverage)}</td>
                  <td>{scan.browserStatus ?? "—"}</td>
                  <td>{scan.durationSeconds === null ? "—" : `${scan.durationSeconds}s`}</td>
                  <td>{dateTime.format(new Date(scan.acceptedAt))}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </main>
  );
}
