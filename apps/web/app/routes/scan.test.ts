/**
 * The scan pages asked of the whole process over HTTP: what a browser receives
 * before its own script asks the API for anything, and the settings each
 * page's loader hands that script. The scan itself is read by the browser
 * from the API, with the token the browser holds, so no scan is in the page.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ask } from "../../testing/scanner";
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
