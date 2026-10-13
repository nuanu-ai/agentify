/**
 * The report pages asked of the whole process over HTTP, for the visitors a
 * test can be without a database: a stranger, who carries no session, and a
 * session the dashboard could not be asked about, here because the scanner is
 * given no address to ask it at. What a signed-in person is shown needs the
 * database and is held by each loader's own test.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ask } from "../../testing/scanner";

const SESSION = { cookie: "agentify.session_token=a-session-the-dashboard-was-not-asked-about" };

beforeEach(() => {
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("APP_BASE_URL", "https://agentify.ad");
  vi.stubEnv("DATABASE_URL", "postgresql://nobody:unused@127.0.0.1:1/nowhere");
  vi.stubEnv("DASHBOARD_IDENTITY_URL", "");
  vi.stubEnv("REPORT_IDENTITY_SECRET", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

const page = async (path: string, headers: Record<string, string> = {}) => {
  const answered = await ask(path, { headers: { accept: "text/html", ...headers } });
  const html = await answered.text();
  const head = html.slice(0, html.indexOf("</head>"));
  return {
    answered,
    html,
    h1: html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/)?.[1]?.replace(/<[^>]+>/g, ""),
    links: [...html.matchAll(/<a\b[^>]*\bhref="([^"]+)"/g)].map((match) => match[1] ?? ""),
    title: head.match(/<title>([^<]*)<\/title>/)?.[1],
    meta: (name: string) => head.match(new RegExp(`<meta name="${name}" content="([^"]*)"`))?.[1],
  };
};

describe("the latest report", () => {
  it("sends a stranger to the dashboard's sign-in, kept by nobody", async () => {
    const answered = await ask("/report/latest");

    expect(answered.status).toBe(307);
    expect(answered.headers.get("location")).toBe("/dashboard/sign-in");
    expect(answered.headers.get("cache-control")).toBe("private, no-store");
    expect(answered.headers.get("x-robots-tag")).toBe("noindex, nofollow");
  });

  it("says it cannot tell whose reports to open when the dashboard does not answer, and offers to try again", async () => {
    const { answered, h1, links } = await page("/report/latest", SESSION);

    expect(answered.status).toBe(200);
    expect(answered.headers.get("cache-control")).toBe("private, no-store");
    expect(h1).toBe("We cannot tell who is visiting right now");
    expect(links).toContain("/report/latest");
  });

  it("is titled as the visitor's latest report and asks no crawler to index or follow it", async () => {
    const { title, meta } = await page("/report/latest", SESSION);

    expect(title).toBe("Your latest report · Agentify");
    expect(meta("robots")).toBe("noindex, nofollow");
  });
});
