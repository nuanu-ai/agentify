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
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { OperatorDashboard } from "../../components/operator-dashboard.server";
import type { OperatorDashboard as Numbers } from "../../lib/server/operator-dashboard";
import { ask } from "../../testing/scanner";

const SESSION = "agentify.session_token";
const HEADING = "Agentify operating dashboard";
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

/** The text of the first element of this kind on a page, or null. */
const textOf = (tag: "title" | "h1", html: string): string | null =>
  html.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`))?.[1]?.replace(/<[^>]+>/g, "") ??
  null;

/**
 * Asserts that `/admin` is the page for an address the site does not have, for
 * this visitor: as a page, a HEAD, a client navigation and a post to either,
 * none of them carrying the dashboard.
 */
async function expectTheMissingPage(headers: Record<string, string>): Promise<void> {
  const missing = await (await ask("/nimda", { headers })).text();
  const answered = await ask("/admin", { headers });
  const html = await answered.text();

  expect(answered.status).toBe(404);
  expect(textOf("title", html)).toBe(textOf("title", missing));
  expect(textOf("h1", html)).toBe(textOf("h1", missing));
  expect((await ask("/admin", { method: "HEAD", headers })).status).toBe(404);
  const navigated = await ask("/admin.data", { headers });
  expect(navigated.status).toBe(404);
  const bodies = [html, await navigated.text()];
  for (const path of ["/admin", "/admin.data"]) {
    const posted = await ask(path, { method: "POST", headers });
    expect(posted.status, `POST ${path}`).toBe(404);
    bodies.push(await posted.text());
  }
  for (const body of bodies) {
    expect(body).not.toContain(HEADING);
    expect(body).not.toContain("Operator dashboard");
  }
}

describe("the operator's dashboard at /admin", () => {
  it("is the page for an address the site does not have, to a browser with no session", async () => {
    await expectTheMissingPage({});
  });

  it("is the same to a signed-in person without the operator flag", async () => {
    await expectTheMissingPage({ cookie: `${SESSION}=person` });
  });

  it("is the same to an operator while the seller dashboard cannot say who is visiting", async () => {
    vi.stubEnv("DASHBOARD_IDENTITY_URL", "http://127.0.0.1:1");

    await expectTheMissingPage({ cookie: `${SESSION}=operator` });
  });

  it("goes on to read the numbers for an operator, and says it failed while it cannot", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});

    const answered = await ask("/admin", { headers: { cookie: `${SESSION}=operator` } });

    expect(answered.status).toBe(500);
    expect(await answered.text()).toContain("Something went wrong");
  });

  it("tells an operator, and nobody else, that it takes no posts", async () => {
    const posted = await ask("/admin", {
      method: "POST",
      headers: { cookie: `${SESSION}=operator` },
    });

    expect(posted.status).toBe(405);
    expect(posted.headers.get("allow")).toBe("GET, HEAD");
  });

  it("has nothing under it, even for an operator", async () => {
    const answered = await ask("/admin/users", { headers: { cookie: `${SESSION}=operator` } });

    expect(answered.status).toBe(404);
    expect(await answered.text()).not.toContain(HEADING);
  });
});

const NUMBERS: Numbers = {
  generatedAt: "2026-10-13T08:00:00.000Z",
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
  daily: [
    {
      day: "2026-10-13",
      visitors: 40,
      landingViews: 70,
      scans: 21,
      completedScans: 20,
      verifiedRegistrations: 1,
      shares: 0,
    },
  ],
  recentScans: [
    {
      scanId: "0190f4c5-1111-7222-8333-944455556666",
      targetHost: "<img src=x onerror=alert(1)>.example",
      segment: "owner",
      status: "completed",
      score: 72,
      coverage: 0.94,
      level: "ahead_of_market",
      acceptedAt: "2026-10-13T07:58:00.000Z",
      finishedAt: "2026-10-13T07:59:10.000Z",
      durationSeconds: 70,
      browserStatus: "completed",
    },
  ],
  selfScan: null,
};

describe("the operator's dashboard, drawn", () => {
  const drawn = renderToStaticMarkup(<OperatorDashboard data={NUMBERS} />);
  const metric = (label: string) =>
    drawn.match(new RegExp(`<article[^>]*><p>${label}</p>[\\s\\S]*?</article>`))?.[0] ?? "";

  it("shows the numbers it was given", () => {
    expect(metric("Visitors")).toContain("1,234");
    expect(metric("Scans")).toContain("640");
    expect(drawn).toContain("$1.2345");
  });

  it("says beside a number read from the analytics events that it counts only those who allowed measurement", () => {
    for (const label of ["Landing views", "Reports shared"]) {
      expect(metric(label), label).toContain("Only visitors who allowed measurement");
    }
    expect(metric("Scans")).not.toContain("allowed measurement");
  });

  it("draws a scanned site's hostname as text, whatever it holds", () => {
    expect(drawn).not.toContain("<img src=x");
    expect(drawn).toContain("&lt;img src=x onerror=alert(1)&gt;.example");
  });

  it("says no self-check has completed rather than drawing an empty one", () => {
    expect(drawn).toContain("No Agentify self-scan has completed yet.");
  });
});
