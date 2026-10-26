import { Badge, type BadgeTone, SurfaceNote } from "@agentify/ui";
import { SURFACE_MARKER_ATTRIBUTE, SURFACE_WORDS } from "@agentify/ui/surface";
import { WorkspaceFrame } from "@agentify/ui/workspace";
import type { ChannelView } from "@agentify/ui/workspace-view";
import { dayIn, momentIn } from "@agentify/ui/zone";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import type {
  OperatorDashboard as OperatorDashboardData,
  OperatorDay,
} from "../lib/server/operator-dashboard";
import { SCAN_LIMITS } from "../lib/server/scan-limits";
import {
  evaluateOperationalSignals,
  evaluateWorkerHeartbeat,
  HEARTBEAT_FRESH_MS,
} from "../lib/server/worker-health";

const number = new Intl.NumberFormat("en-US");
const percent = new Intl.NumberFormat("en-US", { style: "percent", maximumFractionDigits: 1 });
// A browser run costs cents, so the hundredth of a cent is kept rather than
// rounded away.
const usd = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 4 });
const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;

/**
 * Moments and days as the operator's workspace writes them, so the scanner's
 * page reads like the rest of it: a moment to the second in the operator's
 * zone with the zone named, or in UTC, said as UTC, where their browser named
 * none, and a day written out in their calendar.
 */
const moment = (at: Date, zone: string | null): ReactNode => {
  const parts = momentIn(at, zone);
  // Two halves a line may break between and nowhere else, as the dashboard
  // draws a moment, with nothing added to the text a reader copies.
  return parts === null ? (
    "—"
  ) : (
    <span className="when">
      <span>{parts.date}</span> <span>{`${parts.time} ${parts.zone}`}</span>
    </span>
  );
};
const day = (at: Date, zone: string | null): string => {
  const parts = dayIn(at, zone);
  return parts === null ? "—" : `${parts.day} ${MONTHS[parts.month - 1]} ${parts.year}`;
};

/**
 * A chart's day as the workspace's charts label it, and the clock beside the
 * last one. The days are counted by UTC day, so both stay UTC whatever the
 * operator's zone.
 */
const chartDay = (at: Date): string =>
  `${at.getUTCDate()} ${(MONTHS[at.getUTCMonth()] ?? "").slice(0, 3)}`;
const clock = (at: Date): string => at.toISOString().slice(11, 16);

/**
 * Said beside every number read from the analytics events, which hold only the
 * visitors who allowed product analytics or ads measurement.
 */
const MEASURED_ONLY = "Only visitors who allowed measurement";

const ratio = (value: number, denominator: number) =>
  denominator > 0 ? percent.format(value / denominator) : "—";

const counted = (count: number, one: string, many: string) =>
  `${number.format(count)} ${count === 1 ? one : many}`;

/** A span of time in the largest unit that keeps it readable. */
function span(seconds: number): string {
  const whole = Math.max(0, Math.round(seconds));
  if (whole < 90) return `${whole} s`;
  const minutes = Math.round(whole / 60);
  if (minutes < 90) return `${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h`;
  return `${Math.round(hours / 24)} days`;
}

/** A scan's, a check's or a browser run's state, as a badge says it. */
const STATES: Readonly<Record<string, readonly [BadgeTone, string]>> = {
  pass: ["pass", "Pass"],
  partial: ["partial", "Partial"],
  fail: ["fail", "Fail"],
  completed: ["pass", "Completed"],
  failed: ["fail", "Failed"],
  blocked: ["fail", "Blocked"],
  budget_skipped: ["notice", "Skipped: budget spent"],
  accepted: ["progress", "Accepted"],
  queued: ["progress", "Queued"],
  pending: ["progress", "Pending"],
  starting: ["progress", "Starting"],
  running: ["progress", "Running"],
  unavailable: ["quiet", "Unavailable"],
  not_applicable: ["quiet", "Not applicable"],
};

function State({ status, none }: Readonly<{ status: string | null; none: string }>) {
  if (status === null) return <Badge tone="quiet">{none}</Badge>;
  const [tone, words] = STATES[status] ?? [
    "quiet",
    `${status.charAt(0).toUpperCase()}${status.slice(1).replaceAll("_", " ")}`,
  ];
  return <Badge tone={tone}>{words}</Badge>;
}

function Tile({
  label,
  figure,
  aside,
}: Readonly<{ label: string; figure: string; aside: string }>) {
  return (
    <div className="tile">
      <p className="label">{label}</p>
      <p className="figure">{figure}</p>
      <p className="aside">{aside}</p>
    </div>
  );
}

function Fact({ term, children }: Readonly<{ term: string; children: ReactNode }>) {
  return (
    <div>
      <dt>{term}</dt>
      <dd>{children}</dd>
    </div>
  );
}

const CHART = { width: 760, height: 240, left: 44, right: 752, top: 14, base: 206 } as const;
const BAR = 9;
/** How tall a day with nothing is drawn, so it reads as a day rather than a gap. */
const EMPTY_BAR = 2;
const round = (value: number) => Math.round(value * 10) / 10;

/** The top of the scale: four steps of 1, 2, 2.5 or 5 times a power of ten, reaching `largest`. */
function scaleTop(largest: number): number {
  const rough = largest / 4;
  if (rough <= 1) return 4;
  const power = 10 ** Math.floor(Math.log10(rough));
  const step =
    [1, 2, 2.5, 5, 10].map((factor) => factor * power).find((candidate) => candidate >= rough) ??
    10 * power;
  return Math.ceil(step) * 4;
}

/** What the days of the chart add up to, in words. */
function chartSummary(rows: readonly OperatorDay[]): string {
  const landings = rows.reduce((sum, row) => sum + row.landingViews, 0);
  const scans = rows.reduce((sum, row) => sum + row.scans, 0);
  const outnumbered = rows.filter((row) => row.scans > row.landingViews).length;
  const first = rows[0];
  const last = rows.at(-1);
  return first && last
    ? `${counted(landings, "landing view", "landing views")} and ${counted(scans, "scan", "scans")} from ${chartDay(new Date(`${first.day}T00:00:00Z`))} to today${
        outnumbered > 0
          ? `; on ${counted(outnumbered, "day", "days")} scans outnumbered measured landing views`
          : ""
      }`
    : "No days to draw";
}

/**
 * Landing views against scans per day. Both series share one scale, the larger
 * of the two, so a day with more scans than measured landing views is drawn
 * whole rather than cut off at the top.
 */
function DailyChart({ rows, readAt }: Readonly<{ rows: OperatorDay[]; readAt: string }>) {
  const top = scaleTop(Math.max(0, ...rows.map((row) => Math.max(row.landingViews, row.scans))));
  const plot = CHART.base - CHART.top;
  const slot = (CHART.right - CHART.left) / Math.max(1, rows.length);
  const dayOf = (row: OperatorDay, at: number) =>
    `${chartDay(new Date(`${row.day}T00:00:00Z`))}${
      at === rows.length - 1 ? `, until ${clock(new Date(readAt))} UTC` : ""
    }`;
  const bar = (value: number, x: number, series: string, label: string, soft: boolean) => {
    // However small beside the other series, a day with something stands taller than one with nothing.
    const height = value > 0 ? Math.max(EMPTY_BAR + 1, round((value / top) * plot)) : EMPTY_BAR;
    const kind = value > 0 ? (soft ? "bar soft" : "bar") : "bar zero";
    return (
      <rect
        className={kind}
        x={round(x)}
        y={round(CHART.base - height)}
        width={BAR}
        height={height}
        rx={2}
      >
        <title>{`${label}: ${counted(value, series, `${series}s`)}`}</title>
      </rect>
    );
  };

  // The picture is for the eye; a screen reader is read the same days as words.
  return (
    <>
      <svg aria-hidden="true" className="op-chart" viewBox={`0 0 ${CHART.width} ${CHART.height}`}>
        {[0, 1, 2, 3, 4].map((step) => {
          const y = round(CHART.base - (plot * step) / 4);
          return (
            <g key={step}>
              <line
                className={step === 0 ? "base" : "grid"}
                x1={CHART.left}
                y1={y}
                x2={CHART.right}
                y2={y}
              />
              <text className="right" x={CHART.left - 8} y={y + 4}>
                {number.format((top * step) / 4)}
              </text>
            </g>
          );
        })}
        {rows.map((row, at) => {
          const x = CHART.left + at * slot + (slot - 2 * BAR - 2) / 2;
          const label = dayOf(row, at);
          return (
            <g key={row.day}>
              {bar(row.landingViews, x, "landing view", label, true)}
              {bar(row.scans, x + BAR + 2, "scan", label, false)}
            </g>
          );
        })}
        {rows.map((row, at) =>
          at === rows.length - 1 || (at % 7 === 0 && rows.length - 1 - at > 3) ? (
            <text
              className={at === rows.length - 1 ? "mid end" : "mid"}
              key={row.day}
              x={round(CHART.left + at * slot + slot / 2)}
              y={CHART.height - 12}
            >
              {at === rows.length - 1 ? "Today" : chartDay(new Date(`${row.day}T00:00:00Z`))}
            </text>
          ) : null,
        )}
      </svg>
      <ul className="sr-only">
        {rows.map((row, at) => (
          <li key={row.day}>
            {`${dayOf(row, at)}: ${counted(row.landingViews, "landing view", "landing views")}, ${counted(row.scans, "scan", "scans")}`}
          </li>
        ))}
      </ul>
    </>
  );
}

/** Why the health check would not call the worker ready, in its own order. */
function notReadyBecause(
  heartbeat: OperatorDashboardData["worker"]["heartbeat"],
  worker: ReturnType<typeof evaluateWorkerHeartbeat>,
): string {
  if (heartbeat === null) return "no heartbeat recorded";
  if (!worker.heartbeatFresh) return `no heartbeat in the last ${span(HEARTBEAT_FRESH_MS / 1000)}`;
  const reasons = [
    ...(worker.databaseConnected ? [] : ["its database is not connected"]),
    ...(worker.queueConnected ? [] : ["its queue is not connected"]),
  ];
  return reasons.length > 0 ? reasons.join("; ") : "it reports itself not ready";
}

function WorkerPanel({ data }: Readonly<{ data: OperatorDashboardData }>) {
  const { heartbeat, signals } = data.worker;
  const readAt = new Date(data.generatedAt);
  const worker = evaluateWorkerHeartbeat(heartbeat ?? undefined, readAt);
  const health = evaluateOperationalSignals(signals);
  const healthy = worker.ready && health.scannerCapacity && health.analyticsOutbox;
  const queued = Number(signals.queued_scans);
  const stuck = Number(signals.stale_running);
  const pending = Number(signals.outbox_pending);
  const deadLetters = Number(signals.outbox_dead_letters);
  const heartbeatAge =
    heartbeat === null
      ? null
      : (readAt.getTime() - new Date(heartbeat.heartbeat_at).getTime()) / 1000;

  return (
    <section className="op-panel" aria-labelledby="worker-title">
      <div className="op-panel-head">
        <h2 id="worker-title">The scanner's worker</h2>
        <Badge tone={healthy ? "pass" : "fail"}>{healthy ? "Healthy" : "Degraded"}</Badge>
      </div>
      <div className="op-panel-body">
        <dl className="op-dl">
          <Fact term="Last heartbeat">
            {heartbeatAge === null ? (
              <Badge tone="fail">None recorded</Badge>
            ) : (
              <Badge
                tone={worker.heartbeatFresh ? "pass" : "fail"}
              >{`${span(heartbeatAge)} ago`}</Badge>
            )}
          </Fact>
          <Fact term="Ready to take scans">
            {worker.ready ? (
              <Badge tone="pass">Ready</Badge>
            ) : (
              <>
                <Badge tone="fail">Not ready</Badge>{" "}
                <span className="op-sub">{notReadyBecause(heartbeat, worker)}</span>
              </>
            )}
          </Fact>
          <Fact term="Scan capacity">
            <Badge tone={health.scannerCapacity ? "pass" : "fail"}>
              {health.scannerCapacity ? "Keeping up" : "Not keeping up"}
            </Badge>
          </Fact>
          <Fact term="Oldest queued scan">
            {queued > 0
              ? `${span(Number(signals.queue_age_seconds))}, ${counted(queued, "scan", "scans")} queued`
              : "Nothing queued"}
          </Fact>
          <Fact term="Scans stuck running">{stuck > 0 ? number.format(stuck) : "None"}</Fact>
          <Fact term="Failed · 15 min">
            {`${number.format(Number(signals.failed_15m))} of ${counted(Number(signals.accepted_15m), "scan", "scans")} accepted`}
          </Fact>
          <Fact term="Analytics outbox">
            <Badge tone={health.analyticsOutbox ? "pass" : "fail"}>
              {health.analyticsOutbox ? "Delivering" : deadLetters > 0 ? "Failing" : "Overdue"}
            </Badge>{" "}
            <span className="op-sub">
              {`${deadLetters > 0 ? `${counted(deadLetters, "event", "events")} given up` : "No event given up"}; ${
                pending > 0
                  ? `longest overdue ${span(Number(signals.outbox_age_seconds))}`
                  : "nothing waiting"
              }`}
            </span>
          </Fact>
        </dl>
      </div>
      <p className="op-panel-foot">
        Healthy or degraded by the rules of the scanner's own health check. An analytics event is
        given up, a dead letter, when the analytics service refuses it or it runs out of attempts;
        it is never sent again.
      </p>
    </section>
  );
}

/** Everything on the page under the workspace's bar, from the numbers the loader read. */
export function OperatorDashboard({
  data,
  zone,
}: Readonly<{ data: OperatorDashboardData; zone: string | null }>) {
  const { overview, selfScan, dataCopies } = data;
  const shown = data.recentScans.length;
  const total = Math.max(shown, overview.scansTotal);

  return (
    <>
      <p className="op-asof">
        Last 30 days · read {moment(new Date(data.generatedAt), zone)} · contact details and raw
        evidence are not shown
      </p>

      <div className="summary op-figures">
        <Tile
          label="Visitors"
          figure={number.format(overview.visitors30d)}
          aside={`Counted once they make a privacy choice or start a scan; ${number.format(overview.visitorsTotal)} all time`}
        />
        <Tile
          label="Landing views"
          figure={number.format(overview.landingViews30d)}
          aside={MEASURED_ONLY}
        />
        <Tile
          label="Scans"
          figure={number.format(overview.scans30d)}
          aside={`${counted(overview.uniqueSites30d, "site", "sites")}; ${number.format(overview.completedScans30d)} completed or partial; ${number.format(overview.scansTotal)} all time`}
        />
        <Tile
          label="Verified registrations"
          figure={number.format(overview.verifiedRegistrations30d)}
          aside={`${ratio(overview.verifiedRegistrations30d, overview.scans30d)} of scans; ${counted(overview.shares30d, "report", "reports")} shared by visitors who allowed measurement`}
        />
        <Tile
          label="Data copies not sent"
          figure={number.format(dataCopies.unsent)}
          aside={
            dataCopies.unsent > 0 && dataCopies.oldestAt !== null
              ? `Oldest asked for ${day(new Date(dataCopies.oldestAt), zone)}. The mail service took none of five tries over an hour; each stays counted until a later copy to its address is sent.`
              : "Every copy asked for was sent or is still being tried."
          }
        />
      </div>

      <section className="op-panel" aria-labelledby="trend-title">
        <div className="op-panel-head">
          <h2 id="trend-title">Landing views and scans</h2>
          <div className="op-legend">
            <span>
              <i className="soft" />
              Landing views · {MEASURED_ONLY.toLowerCase()}
            </span>
            <span>
              <i />
              Scans · every visitor
            </span>
          </div>
        </div>
        <div className="op-panel-body">
          <DailyChart rows={data.daily} readAt={data.generatedAt} />
        </div>
        <p className="op-panel-foot">
          {chartSummary(data.daily)}. Both series share one scale, the larger of the two, so a day
          with more scans than measured landing views is drawn whole.
        </p>
      </section>

      <div className="op-two">
        <section className="op-panel" aria-labelledby="self-title">
          <div className="op-panel-head">
            <h2 id="self-title">Can agents read agentify.ad?</h2>
            {selfScan ? (
              <p>The latest self-scan, {moment(new Date(selfScan.acceptedAt), zone)}</p>
            ) : null}
          </div>
          <div className="op-panel-body">
            {selfScan ? (
              <>
                <div className="op-score">
                  <strong>{selfScan.score ?? "—"}</strong>
                  <span>
                    {[
                      "of 100",
                      selfScan.level?.replaceAll("_", " ") ?? selfScan.status,
                      ...(selfScan.coverage === null
                        ? []
                        : [`coverage ${percent.format(selfScan.coverage)}`]),
                    ].join(" · ")}
                  </span>
                </div>
                <dl className="op-dl">
                  <Fact term="Substantive initial HTML">
                    <State status={selfScan.substantiveHtmlStatus} none="Not assessed" />
                  </Fact>
                  <Fact term="ChatGPT-User and Claude-User compatibility">
                    <State status={selfScan.agentUserAgentStatus} none="Not assessed" />
                  </Fact>
                  <Fact term="Passive browser observation">
                    <State status={selfScan.browserStatus} none="Not sampled" />
                  </Fact>
                </dl>
              </>
            ) : (
              <p>No Agentify self-scan has completed yet.</p>
            )}
          </div>
          <p className="op-panel-foot">
            A pass proves public HTTP compatibility at scan time. It does not prove that a model
            indexed, cited or recommended Agentify.
          </p>
        </section>

        <section className="op-panel" aria-labelledby="abuse-title">
          <div className="op-panel-head">
            <h2 id="abuse-title">Abuse controls</h2>
            <Badge tone={data.turnstileEnforced ? "pass" : "notice"}>
              {data.turnstileEnforced ? "Turnstile enforced" : "Turnstile not enforced"}
            </Badge>
          </div>
          <div className="op-panel-body">
            <dl className="op-dl">
              <Fact term="Free anonymous scans">
                {data.turnstileEnforced
                  ? `${SCAN_LIMITS.freePerAddressHour} per address per rolling hour, then the challenge`
                  : "Every scan up to the ceilings: the challenge is not enforced"}
              </Fact>
              <Fact term="Hard ceiling per address">
                {`${SCAN_LIMITS.perAddressHour} per rolling hour`}
              </Fact>
              <Fact term="Hard ceiling per site">{`${SCAN_LIMITS.perSiteDay} per UTC day`}</Fact>
              <Fact term="Accepted requests · 24 h">
                {number.format(overview.acceptedRequests24h)}
              </Fact>
              <Fact term="Verified challenges · rolling hour">
                {data.turnstileEnforced
                  ? number.format(overview.challengePasses1h)
                  : "Not enforced"}
              </Fact>
              <Fact term="Browser spending today">
                {`${usd.format(overview.browserUsageUsdToday)} USD; no cap shown: the worker does not report it`}
              </Fact>
            </dl>
          </div>
          <p className="op-panel-foot">
            Turnstile is Cloudflare's challenge that tells a person from a script; a visitor meets
            it after the free scans. The limits are read from the code that enforces them, and the
            hard ceilings hold even when Turnstile is down.
          </p>
        </section>
      </div>

      <WorkerPanel data={data} />

      <section className="group" aria-labelledby="scans-title">
        <div className="group-head">
          <h2 id="scans-title">Latest scans</h2>
          <p className="group-aside">Hostnames only, never the submitted address</p>
        </div>
        <div className="list-box op-cols-scans">
          <ul className="list" aria-label="Latest scans">
            <li className="list-head" aria-hidden="true">
              <span>Site</span>
              <span>Segment</span>
              <span>State</span>
              <span className="num">Score</span>
              <span className="num">Coverage</span>
              <span>Accepted</span>
            </li>
            {data.recentScans.map((scan) => (
              <li className="list-row" key={scan.scanId}>
                <div className="cell cell-title">{scan.targetHost}</div>
                <div className="cell cell-ident soft">
                  <span className="said-on-narrow">Segment </span>
                  {scan.segment}
                </div>
                <div className="cell cell-state">
                  <State status={scan.status} none="Not known" />
                </div>
                {/* One box inside the cell's row of boxes, so the label keeps its space. */}
                <div className="cell cell-action num">
                  <span>
                    <span className="said-on-narrow">Score </span>
                    {scan.score ?? "—"}
                  </span>
                </div>
                <div className="cell cell-action num">
                  <span>
                    <span className="said-on-narrow">Coverage </span>
                    {scan.coverage === null ? "—" : percent.format(scan.coverage)}
                  </span>
                </div>
                <div className="cell cell-fact">
                  <span className="said-on-narrow">Accepted </span>
                  {moment(new Date(scan.acceptedAt), zone)}
                </div>
              </li>
            ))}
          </ul>
        </div>
        <p className="cut">
          {shown === 0
            ? "No scan has been accepted yet"
            : shown < total
              ? `The latest ${number.format(shown)} of ${counted(total, "scan", "scans")}`
              : `All ${counted(shown, "scan", "scans")}`}
        </p>
      </section>
    </>
  );
}

/** The scanner's own pages are anchors here, since the page is markup with no router behind it. */
function Anchor({
  to,
  className,
  "aria-current": current,
  children,
}: Readonly<{ to: string; className?: string; "aria-current"?: "true"; children: ReactNode }>) {
  return (
    <a className={className} href={to} aria-current={current}>
      {children}
    </a>
  );
}

/**
 * The whole page, the workspace's frame around the scanner's numbers, as
 * markup drawn here on the server for `who`, the operator the seller dashboard
 * confirmed. The scanner cannot read the other sections' counts, so it draws
 * none; the band naming the stack is the one the workspace's other pages draw.
 * The frame's menu reads a router's location, which a page drawn as markup has
 * none of, so it is drawn under one of its own.
 */
export function drawOperatorPage({
  data,
  who,
  channel,
  zone,
}: Readonly<{
  data: OperatorDashboardData;
  who: string;
  channel: ChannelView;
  zone: string | null;
}>): string {
  return renderToStaticMarkup(
    <MemoryRouter initialEntries={["/admin"]}>
      <WorkspaceFrame
        surface="scanner"
        link={Anchor}
        who={who}
        channel={channel}
        section="scanner"
        heading="Scanner"
        find="/dashboard/admin/find"
        note={
          <SurfaceNote
            surface={{
              attribute: SURFACE_MARKER_ATTRIBUTE,
              mode: channel.mode,
              words: SURFACE_WORDS[channel.mode],
            }}
          />
        }
      >
        <OperatorDashboard data={data} zone={zone} />
      </WorkspaceFrame>
    </MemoryRouter>,
  );
}
