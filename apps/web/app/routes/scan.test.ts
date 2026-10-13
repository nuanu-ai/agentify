/**
 * The scan pages asked of the whole process over HTTP: what a browser receives
 * before its own script asks the API for anything, and the settings each
 * page's loader hands that script. The scan itself is read by the browser
 * from the API, with the token the browser holds, so no scan is in the page.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { visitTo } from "../../testing/loader-args";
import { ask } from "../../testing/scanner";
import { loader as scanLoader } from "./scan.id";
import { loader as pendingLoader } from "./scan.pending";

beforeEach(() => {
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("APP_BASE_URL", "https://agentify.ad");
  vi.stubEnv("DATABASE_URL", "postgresql://nobody:unused@127.0.0.1:1/nowhere");
  vi.stubEnv("REGISTRATION_ENABLED", "false");
  vi.stubEnv("TURNSTILE_SITE_KEY", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

const page = async (path: string) => {
  const answered = await ask(path, { headers: { accept: "text/html" } });
  const html = await answered.text();
  const head = html.slice(0, html.indexOf("</head>"));
  return {
    answered,
    html,
    h1: html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/)?.[1]?.replace(/<[^>]+>/g, ""),
    title: head.match(/<title>([^<]*)<\/title>/)?.[1],
    meta: (name: string) => head.match(new RegExp(`<meta name="${name}" content="([^"]*)"`))?.[1],
  };
};

describe("the page a scan request is handed to", () => {
  it("says the report is getting ready before its script sends the request, kept by nobody", async () => {
    const { answered, h1 } = await page("/scan/pending?segment=owner");

    expect(answered.status).toBe(200);
    expect(answered.headers.get("cache-control")).toBe("private, no-store");
    expect(answered.headers.get("referrer-policy")).toBe("no-referrer");
    expect(h1).toBe("Your report is getting ready");
  });

  it("is titled as a private scan starting, indexed by no crawler, and leaves no referrer", async () => {
    const { title, meta } = await page("/scan/pending");

    expect(title).toBe("Starting private scan · Agentify");
    expect(meta("robots")).toBe("noindex, nofollow");
    expect(meta("referrer")).toBe("no-referrer");
  });

  it("hands the browser the challenge's site key the process was given, and none where it was given none", () => {
    vi.stubEnv("TURNSTILE_SITE_KEY", "a-runtime-site-key");
    const configured = pendingLoader();
    vi.stubEnv("TURNSTILE_SITE_KEY", "");
    const absent = pendingLoader();

    expect(configured.turnstileSiteKey).toBe("a-runtime-site-key");
    expect(absent.turnstileSiteKey).toBeNull();
  });
});

const SCAN = "0190f4c5-0000-7000-8000-000000000000";

const scanPage = (query = "") =>
  scanLoader(visitTo(`https://agentify.ad/scan/${SCAN}${query}`, { id: SCAN }));

describe("a scan's page", () => {
  it("says it is reading the scan's state before its script asks, kept by nobody", async () => {
    const { answered, html } = await page(`/scan/${SCAN}?segment=store`);

    expect(answered.status).toBe(200);
    expect(answered.headers.get("cache-control")).toBe("private, no-store");
    expect(answered.headers.get("referrer-policy")).toBe("no-referrer");
    expect(html).toContain("Reading the scan state");
  });

  it("is titled as private scan progress, indexed by no crawler, and leaves no referrer", async () => {
    const { title, meta } = await page(`/scan/${SCAN}`);

    expect(title).toBe("Private scan progress · Agentify");
    expect(meta("robots")).toBe("noindex, nofollow");
    expect(meta("referrer")).toBe("no-referrer");
  });

  it("offers the ask for the full report only where the process has registration on", () => {
    vi.stubEnv("REGISTRATION_ENABLED", "true");
    const enabled = scanPage();
    vi.stubEnv("REGISTRATION_ENABLED", "false");
    const disabled = scanPage();

    expect(enabled.registrationEnabled).toBe(true);
    expect(disabled.registrationEnabled).toBe(false);
  });

  it.each([
    ["?segment=store", "store"],
    ["?segment=local", "local"],
    ["", "owner"],
    ["?segment=somewhere", "owner"],
    ["?segment=store&segment=local", "owner"],
  ])("names the segment the scan was started from: %s", (query, segment) => {
    expect(scanPage(query).segment).toBe(segment);
  });

  it("draws an example state where it is asked for outside production, and never in it", () => {
    const outside = scanPage("?fixture=teaser");
    const unknown = scanPage("?fixture=no-such-state");
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("TOKEN_HMAC_SECRET", "a".repeat(32));
    vi.stubEnv("DASHBOARD_IDENTITY_URL", "http://127.0.0.1:1");
    vi.stubEnv("REPORT_IDENTITY_SECRET", "b".repeat(32));
    const inProduction = scanPage("?fixture=teaser");

    expect(outside.fixture?.status.teaser?.level).toBe("readable");
    expect(unknown.fixture).toBeNull();
    expect(inProduction.fixture).toBeNull();
  });
});
