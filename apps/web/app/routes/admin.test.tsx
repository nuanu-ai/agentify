/**
 * The door of the operator's dashboard at `/admin`, asked of the whole process
 * over HTTP with a stand-in seller dashboard on loopback that knows one
 * operator and one person without the flag, and the dashboard drawn from
 * example numbers. The database listens nowhere, so the door never reads the
 * numbers here; that an operator gets them, from a database the migrations
 * built, and that a refused browser is handed no script carrying the page's
 * words, is held against the build by `admin-door.integration.test.ts`.
 */

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { SURFACE_MARKER_ATTRIBUTE } from "@agentify/ui/surface";
import { CHANNEL_NAMES } from "@agentify/ui/workspace-view";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { drawOperatorPage, OperatorDashboard } from "../../components/operator-dashboard.server";
import type { OperatorDashboard as Numbers } from "../../lib/server/operator-dashboard";
import { SCAN_LIMITS } from "../../lib/server/scan-limits";
import { ask } from "../../testing/scanner";

const SESSION = "agentify.session_token";
let sellerDashboard: Server;
let sellerDashboardAt = "";

beforeAll(async () => {
  sellerDashboard = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => (body += chunk));
    request.on("end", () => {
      const asked = JSON.parse(body || "{}") as { cookie?: string };
      const value = (asked.cookie ?? "").split(`${SESSION}=`)[1]?.split(";")[0] ?? "";
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify(
          value === "operator" || value === "person"
            ? {
                status: "signed_in",
                email: `${value}@example.com`,
                operator: value === "operator",
                request: null,
                set_cookie: [],
              }
            : { status: "signed_out" },
        ),
      );
    });
  });
  await new Promise<void>((resolve) => sellerDashboard.listen(0, "127.0.0.1", resolve));
  sellerDashboardAt = `http://127.0.0.1:${(sellerDashboard.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => sellerDashboard.close(() => resolve()));
});

beforeEach(() => {
  vi.stubEnv("APP_BASE_URL", "https://agentify.ad");
  vi.stubEnv("DATABASE_URL", "postgresql://nobody:unused@127.0.0.1:1/nowhere");
  vi.stubEnv("DASHBOARD_IDENTITY_URL", sellerDashboardAt);
  vi.stubEnv("REPORT_IDENTITY_SECRET", "r".repeat(32));
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("the operator's dashboard at /admin", () => {
  it("goes on to read the numbers for an operator, and says it failed while it cannot", async () => {
    const logged: string[] = [];
    vi.spyOn(console, "error").mockImplementation((line) => {
      logged.push(String(line));
    });

    const answered = await ask("/admin", { headers: { cookie: `${SESSION}=operator` } });

    expect(answered.status).toBe(500);
    expect(await answered.text()).toContain("Something went wrong");
    expect(logged.map((line) => JSON.parse(line))).toContainEqual(
      expect.objectContaining({
        event: "web_unhandled_request_error",
        route: "page_admin",
        error_code: "ECONNREFUSED",
      }),
    );
  });

  it("tells an operator, and nobody else, that it takes no posts", async () => {
    const posted = await ask("/admin", {
      method: "POST",
      headers: { cookie: `${SESSION}=operator` },
    });

    expect(posted.status).toBe(405);
    expect(posted.headers.get("allow")).toBe("GET, HEAD");
  });
});

const READ_AT = "2026-10-13T08:00:00.000Z";
const WORKER_READY = { ready: true, queue_connected: true, database_connected: true };
const HEALTHY_SIGNALS = {
  queued_scans: 0,
  queue_age_seconds: 0,
  stale_running: 0,
  accepted_15m: 20,
  failed_15m: 1,
  outbox_pending: 2,
  outbox_age_seconds: 12,
  outbox_dead_letters: 0,
};

const NUMBERS: Numbers = {
  generatedAt: READ_AT,
  turnstileEnforced: true,
  overview: {
    visitorsTotal: 48_210,
    visitors30d: 1_234,
    landingViews30d: 2_051,
    scansTotal: 9_870,
    scans30d: 640,
    completedScans30d: 598,
    uniqueSites30d: 512,
    verifiedRegistrations30d: 32,
    shares30d: 11,
    acceptedRequests24h: 27,
    challengePasses1h: 4,
    browserUsageUsdToday: 1.2345,
  },
  dataCopies: { unconfirmed: 2, oldestAt: "2026-09-30T10:15:00.000Z" },
  daily: [
    { day: "2026-10-11", landingViews: 70, scans: 21 },
    { day: "2026-10-12", landingViews: 0, scans: 0 },
    { day: "2026-10-13", landingViews: 24, scans: 90 },
  ],
  recentScans: [
    {
      scanId: "0190f4c5-1111-7222-8333-944455556666",
      targetHost: "<img src=x onerror=alert(1)>.example",
      segment: "owner",
      status: "completed",
      score: 72,
      coverage: 0.94,
      acceptedAt: "2026-10-13T07:58:00.000Z",
    },
  ],
  selfScan: null,
  worker: {
    heartbeat: { heartbeat_at: "2026-10-13T07:59:56.000Z", metadata: WORKER_READY },
    signals: HEALTHY_SIGNALS,
  },
};

const draw = (data: Numbers, zone: string | null = null) =>
  renderToStaticMarkup(<OperatorDashboard data={data} zone={zone} />);
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

/** The markup from the first opening tag that matches up to its element's close. */
function part(html: string, opening: RegExp, tag: string): string {
  const at = html.search(opening);
  if (at < 0) return "";
  let depth = 0;
  const tags = new RegExp(`<(/?)${tag}\\b[^>]*>`, "g");
  tags.lastIndex = at;
  for (let found = tags.exec(html); found; found = tags.exec(html)) {
    depth += found[1] === "/" ? -1 : 1;
    if (depth === 0) return html.slice(at, tags.lastIndex);
  }
  return html.slice(at);
}

/** A figure's tile, found by its label. */
const tile = (html: string, label: string) =>
  text(part(html, new RegExp(`<div[^>]*>(?=<p[^>]*>${label}</p>)`), "div"));
const section = (html: string, id: string) =>
  part(html, new RegExp(`<section[^>]*aria-labelledby="${id}"`), "section");

/** Each bar of the chart: where its top is, how tall it is, and what it says. */
function barsOf(html: string) {
  return [
    ...html.matchAll(
      /<rect\b[^>]*\by="([\d.]+)"[^>]*\bheight="([\d.]+)"[^>]*>(?:<title>([^<]*)<\/title>)?/g,
    ),
  ].map(([, y, height, title]) => ({ y: Number(y), height: Number(height), title: title ?? "" }));
}

/** The worker panel's heading line, where its verdict stands. */
const workerVerdict = (data: Numbers) =>
  text(part(section(draw(data), "worker-title"), /<div[^>]*>(?=<h2)/, "div"));

describe("the operator's dashboard, drawn", () => {
  const drawn = draw(NUMBERS);

  it("shows a scan's coverage as the whole percent it has reached, as every page does", () => {
    const [scan] = NUMBERS.recentScans;
    if (!scan) throw new Error("the fixture lists a scan");
    expect(text(draw({ ...NUMBERS, recentScans: [{ ...scan, coverage: 0.698 }] }))).toContain(
      "69%",
    );
  });

  it("shows the figures it was given", () => {
    expect(tile(drawn, "Visitors")).toContain("1,234");
    expect(tile(drawn, "Scans")).toContain("640");
    expect(tile(drawn, "Verified registrations")).toContain("32");
  });

  it("says beside a figure read from the analytics events that it counts only those who allowed measurement", () => {
    expect(tile(drawn, "Landing views")).toMatch(/only visitors.*allowed measurement/i);
    expect(tile(drawn, "Verified registrations")).toMatch(
      /11.*reports shared.*visitors.*allowed measurement/i,
    );
    expect(tile(drawn, "Scans")).not.toContain("allowed measurement");
  });

  it("draws a day with more scans than measured landing views whole, both series on one scale", () => {
    const chart = section(drawn, "trend-title");
    const bars = barsOf(chart);
    const top = Math.min(
      ...[...chart.matchAll(/<line\b[^>]*\by1="([\d.]+)"/g)].map(([, y]) => Number(y)),
    );
    const ninety = bars.find((bar) => bar.title.endsWith(": 90 scans"));
    const seventy = bars.find((bar) => bar.title.endsWith(": 70 landing views"));
    if (!ninety || !seventy) throw new Error("the chart does not label its bars");

    for (const bar of bars) expect(bar.y, bar.title).toBeGreaterThanOrEqual(top);
    expect(ninety.height / seventy.height).toBeCloseTo(90 / 70, 2);
  });

  it("labels every bar with its day and value, and draws a day with nothing as a bar, not a gap", () => {
    const bars = barsOf(section(drawn, "trend-title"));
    const titles = bars.map((bar) => bar.title);

    expect(bars).toHaveLength(NUMBERS.daily.length * 2);
    expect(titles).toContain("11 Oct: 70 landing views");
    expect(titles).toContain("12 Oct: 0 scans");
    // The last day is today, read part of the way through.
    expect(titles).toContain("13 Oct, until 08:00 UTC: 90 scans");
    for (const bar of bars) expect(bar.height, bar.title).toBeGreaterThan(0);
    // A screen reader is read the same days in words, the picture being hidden from it.
    expect(text(section(drawn, "trend-title"))).toContain(
      "13 Oct, until 08:00 UTC: 24 landing views, 90 scans",
    );
  });

  it("writes the figures the chart sums beside it", () => {
    const summary = text(section(drawn, "trend-title"));
    expect(summary).toMatch(/94 landing views.*111 scans/i);
    expect(summary).toMatch(/11 Oct.*today/i);
    expect(summary).toMatch(/1 day.*scans outnumbered.*landing views/i);
  });

  it("draws a day with a little taller than a day with nothing, however large the other series", () => {
    const skewed = draw({
      ...NUMBERS,
      daily: [
        { day: "2026-10-12", landingViews: 0, scans: 0 },
        { day: "2026-10-13", landingViews: 10_000, scans: 1 },
      ],
    });
    const bars = barsOf(section(skewed, "trend-title"));
    const height = (title: string) => {
      const bar = bars.find((bar) => bar.title.endsWith(title));
      expect(bar, title).toBeDefined();
      if (!bar) throw new Error(`No chart bar for ${title}`);
      return bar.height;
    };

    expect(height("13 Oct, until 08:00 UTC: 1 scan")).toBeGreaterThan(height("12 Oct: 0 scans"));
  });

  it("states the scan limits the rate check enforces", () => {
    const controls = text(section(drawn, "abuse-title"));

    expect(controls).toContain(
      `Free anonymous scans ${SCAN_LIMITS.freePerAddressHour} per address per rolling hour`,
    );
    expect(controls).toContain(
      `Hard ceiling per address ${SCAN_LIMITS.perAddressHour} per rolling hour`,
    );
    expect(controls).toContain(`Hard ceiling per site ${SCAN_LIMITS.perSiteDay} per UTC day`);
  });

  it("offers no free scans before a challenge it does not enforce, nor counts its passes", () => {
    const controls = text(section(draw({ ...NUMBERS, turnstileEnforced: false }), "abuse-title"));

    expect(controls).toContain("Turnstile not enforced");
    expect(controls).not.toContain(
      `${SCAN_LIMITS.freePerAddressHour} per address per rolling hour`,
    );
    expect(controls).toContain("Verified challenges · rolling hour Not enforced");
  });

  it("shows today's browser spending to the hundredth of a cent, and no cap, which the worker does not report", () => {
    const spending = text(section(drawn, "abuse-title"));
    expect(spending).toMatch(/browser spending today.*1\.2345 USD/i);
    expect(spending).toMatch(/no cap shown.*worker.*does not report/i);
  });

  it("calls the worker healthy by its health check's rules, and degraded once one of them fails", () => {
    const at = (heartbeat_at: string) => ({ heartbeat_at, metadata: WORKER_READY });
    const signals = (changed: Partial<typeof HEALTHY_SIGNALS>) => ({
      ...NUMBERS,
      worker: { ...NUMBERS.worker, signals: { ...HEALTHY_SIGNALS, ...changed } },
    });

    expect(workerVerdict(NUMBERS)).toContain("Healthy");
    expect(
      workerVerdict({
        ...NUMBERS,
        worker: { ...NUMBERS.worker, heartbeat: at("2026-10-13T07:59:30.000Z") },
      }),
    ).toContain("Degraded");
    expect(workerVerdict(signals({ queued_scans: 1, queue_age_seconds: 11 }))).toContain(
      "Degraded",
    );
    expect(workerVerdict(signals({ stale_running: 1 }))).toContain("Degraded");
    expect(workerVerdict(signals({ outbox_dead_letters: 1 }))).toContain("Degraded");
  });

  it("says how old the worker's heartbeat is, and why the worker is not ready", () => {
    const worker = text(section(drawn, "worker-title"));
    expect(worker).toContain("Last heartbeat 4 s ago");
    expect(worker).toContain("Ready to take scans Ready");

    const queueless = {
      ...NUMBERS,
      worker: {
        ...NUMBERS.worker,
        heartbeat: {
          heartbeat_at: "2026-10-13T07:59:56.000Z",
          metadata: { ...WORKER_READY, queue_connected: false },
        },
      },
    };
    expect(text(section(draw(queueless), "worker-title"))).toMatch(
      /Not ready\W+its queue is not connected/,
    );
  });

  it("says no heartbeat was ever recorded rather than giving an age", () => {
    const silent = { ...NUMBERS, worker: { ...NUMBERS.worker, heartbeat: null } };

    expect(text(section(draw(silent), "worker-title"))).toContain("Last heartbeat None recorded");
    expect(workerVerdict(silent)).toContain("Degraded");
  });

  it("counts the data copies every try failed to send, with the oldest, as needing attention", () => {
    expect(tile(drawn, "Data copies not confirmed")).toMatch(
      /Data copies not confirmed 2 Oldest asked for 30 September 2026/,
    );
    expect(
      tile(
        draw({ ...NUMBERS, dataCopies: { unconfirmed: 0, oldestAt: null } }),
        "Data copies not confirmed",
      ),
    ).toMatch(/every copy.*sent or.*still being tried/i);
  });

  it("draws a scan's state as a badge in words", () => {
    const scans = part(drawn, /<ul[^>]*aria-label="Latest scans"/, "ul");

    expect(text(scans)).toMatch(/completed/i);
    expect(text(scans)).not.toMatch(/failed|unavailable/i);
  });

  it("says how many of all the scans the list shows", () => {
    expect(text(drawn)).toContain("The latest 1 of 9,870 scans");
  });

  it("draws a scanned site's hostname as text, whatever it holds", () => {
    expect(drawn).not.toContain("<img src=x");
    expect(drawn).toContain("&lt;img src=x onerror=alert(1)&gt;.example");
  });

  it("says no self-check has completed rather than drawing an empty one", () => {
    expect(text(section(drawn, "self-title"))).toMatch(/no.*self-scan.*completed/i);
    const completed = draw({
      ...NUMBERS,
      selfScan: {
        scanId: "0190f4c5-1111-7222-8333-944455556666",
        targetHost: "agentify.ad",
        segment: "owner",
        status: "completed",
        score: 72,
        coverage: 0.94,
        level: "ahead_of_market",
        acceptedAt: READ_AT,
        finishedAt: READ_AT,
        substantiveHtmlStatus: "pass",
        agentUserAgentStatus: "pass",
        browserStatus: "completed",
      },
    });
    const self = text(section(completed, "self-title"));
    expect(self).toMatch(/72.*of 100.*ahead of market.*coverage 94%/i);
    expect(self).not.toMatch(/no.*self-scan.*completed/i);
  });
});

describe("the moments on the operator's dashboard", () => {
  it("are written in the zone the operator's browser named, and name it", () => {
    const zoned = text(
      draw(
        { ...NUMBERS, dataCopies: { unconfirmed: 1, oldestAt: "2026-09-30T20:15:00.000Z" } },
        "Asia/Makassar",
      ),
    );

    expect(zoned).toContain("read 2026-10-13 16:00:00 UTC+8");
    expect(zoned).toContain("Accepted 2026-10-13 15:58:00 UTC+8");
    expect(zoned).toContain("Oldest asked for 1 October 2026");
  });

  it("are written in UTC, said as UTC, where the operator's browser named no zone", () => {
    const plain = text(draw(NUMBERS));

    expect(plain).toContain("read 2026-10-13 08:00:00 UTC");
    expect(plain).toContain("Accepted 2026-10-13 07:58:00 UTC");
  });

  it("keep the chart's days and the ceiling per site in UTC, the days they are counted by", () => {
    const zoned = draw(NUMBERS, "Asia/Makassar");

    expect(barsOf(zoned).map((bar) => bar.title)).toContain("13 Oct, until 08:00 UTC: 90 scans");
    expect(text(zoned)).toContain(`Hard ceiling per site ${SCAN_LIMITS.perSiteDay} per UTC day`);
  });
});

describe("the operator's page, in the workspace's frame", () => {
  const page = drawOperatorPage({
    data: NUMBERS,
    who: "operator@example.com",
    channel: { mode: "test", name: CHANNEL_NAMES.test },
    zone: null,
  });
  const sidebar = part(page, /<aside\b/, "aside");
  const linkTo = (words: string) =>
    sidebar.match(new RegExp(`<a[^>]*href="([^"]*)"[^>]*>${words}</a>`))?.[1] ?? null;

  it("leads from its sidebar to every other section, the seller dashboard's pages of the workspace", () => {
    expect(linkTo("Overview")).toBe("/dashboard/admin");
    expect(linkTo("Merchants")).toBe("/dashboard/admin/merchants");
    expect(linkTo("Orders")).toBe("/dashboard/admin/orders");
    expect(linkTo("Money")).toBe("/dashboard/admin/money");
    expect(linkTo("Health")).toBe("/dashboard/admin/health");
    expect(linkTo("Accounts")).toBe("/dashboard/admin/accounts");
    expect(linkTo("Journal")).toBe("/dashboard/admin/journal");
  });

  it("marks the scanner as the section on screen, and is no link to itself", () => {
    expect(sidebar).toContain('<span aria-current="page">Scanner</span>');
    expect(linkTo("Scanner")).toBeNull();
  });

  it("draws the channel's band on the test channel, as the workspace's pages do, and only the marker on the live one", () => {
    expect(text(page)).toMatch(/payments.*test (?:funds|money).*not real money/i);
    expect(page).toContain(`${SURFACE_MARKER_ATTRIBUTE}="test"`);

    const live = drawOperatorPage({
      data: NUMBERS,
      who: "operator@example.com",
      channel: { mode: "live", name: CHANNEL_NAMES.live },
      zone: null,
    });
    expect(live).toContain(`${SURFACE_MARKER_ATTRIBUTE}="live"`);
    expect(live).not.toContain('class="surface-words"');
  });

  it("draws no section's count, which it cannot read, rather than a zero", () => {
    const words = text(sidebar);
    expect(words).toMatch(/Scanner/);
    expect(words).not.toMatch(/\b0\b|\bzero\b/i);
  });

  it("finds a record through the workspace's lookup, and names the operator with the way out", () => {
    expect(page).toMatch(/<form[^>]*action="\/dashboard\/admin\/find"/);
    expect(page).toContain("operator@example.com");
    expect(page).toMatch(/<form[^>]*action="\/dashboard\/sign-out"/);
  });
});
