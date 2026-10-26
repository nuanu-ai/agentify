/**
 * The scan routes, asked of the whole process over HTTP: accepting a scan,
 * its status and its browser observation, and publishing and revoking a
 * scan's public link. What each one decides before it reads a record is
 * answered here; the rest is the integration suite's, which has a database.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  allowedAt,
  fromSite,
  ORIGIN,
  refusalOf,
  SIGNED_IN,
  stubOfflineScanner,
} from "../../../../testing/api";
import { ask } from "../../../../testing/scanner";

beforeEach(stubOfflineScanner);

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const SCAN = "0190f4c5-0000-7000-8000-000000000000";

const scanAsked = {
  url: "https://example.com",
  segment: "store",
  landing_variant: "store-v1",
  turnstile_token: null,
};

const accept = (body: unknown, headers: Record<string, string> = {}) =>
  fromSite("/api/v1/scans", "POST", body, { "idempotency-key": "scan-key-0001", ...headers });

describe("accepting a scan", () => {
  it.each([
    ["no origin", { origin: "" }],
    ["another origin", { origin: "https://elsewhere.example" }],
  ])("refuses a scan asked from %s", async (_from, headers) => {
    const answered = await accept(scanAsked, headers);

    expect(answered.status).toBe(403);
    expect(answered.headers.get("set-cookie")).toBeNull();
    expect((await refusalOf(answered)).code).toBe("invalid_origin");
  });

  it("is paused while acceptance is switched off, and says to ask again in a minute", async () => {
    vi.stubEnv("SCAN_ACCEPTANCE_ENABLED", "false");

    const answered = await accept(scanAsked);

    expect(answered.status).toBe(503);
    expect(await refusalOf(answered)).toMatchObject({
      code: "temporarily_busy",
      retryable: true,
      retry_after_seconds: 60,
    });
  });

  it.each([
    ["without an idempotency key", {}],
    ["with a key shorter than eight characters", { "idempotency-key": "short" }],
    ["with a key longer than two hundred", { "idempotency-key": "k".repeat(201) }],
  ])("refuses a scan asked %s", async (_how, headers) => {
    const answered = await fromSite("/api/v1/scans", "POST", scanAsked, headers);

    expect(answered.status).toBe(400);
    expect((await refusalOf(answered)).code).toBe("invalid_idempotency_key");
  });

  it.each([
    ["is not JSON", "not json"],
    ["names no address", { ...scanAsked, url: "" }],
    ["names an address that is not on the web", { ...scanAsked, url: "ftp://example.com" }],
    ["names no segment", { ...scanAsked, segment: undefined }],
  ])("refuses a scan whose request %s", async (_why, body) => {
    const answered = await accept(body);

    expect(answered.status).toBe(400);
    expect(await refusalOf(answered)).toMatchObject({
      code: "invalid_url",
      message: "Provide a valid public HTTP(S) URL.",
    });
  });

  it("refuses an address the scanner will not visit, and says what one it will visit looks like", async () => {
    const answered = await accept({ ...scanAsked, url: "https://example.com:8443" });

    expect(answered.status).toBe(400);
    const refusal = await refusalOf(answered);
    expect(refusal.code).toBe("invalid_url");
    expect(refusal.message).toContain("with no port");
  });

  it("looks for the scan a returning visitor already asked for, by the visitor's cookie, and says when it could not", async () => {
    const answered = await accept(scanAsked, {
      cookie: "theme=dark; agentify_anonymous=a-visitor",
    });

    expect(answered.status).toBe(503);
    expect(answered.headers.get("cache-control")).toBe("no-store");
    expect(await refusalOf(answered)).toMatchObject({
      code: "temporarily_busy",
      message: "The scanner could not read its records just now.",
      retryable: true,
      retry_after_seconds: 30,
    });
  });

  it("fails as a whole, leaving one line that names the route and the failure's kind, where the limits cannot be counted", async () => {
    const lines: string[] = [];
    vi.spyOn(console, "error").mockImplementation((line: unknown) => {
      lines.push(String(line));
    });

    const answered = await accept(scanAsked);

    expect(answered.status).toBe(500);
    expect(answered.headers.get("set-cookie")).toBeNull();
    expect(
      lines
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .filter((line) => line.event === "web_unhandled_request_error"),
    ).toEqual([
      expect.objectContaining({
        route: "api_v1_scans_create",
        method: "POST",
        error_code: "ECONNREFUSED",
      }),
    ]);
  });

  it("takes a post alone", async () => {
    const read = await ask("/api/v1/scans");

    expect(read.status).toBe(405);
    expect(await read.text()).toBe("");
    expect(await allowedAt("/api/v1/scans")).toBe("OPTIONS, POST");
  });
});

describe("a scan's status and its browser observation", () => {
  it.each([
    ["status", "no token", {}],
    ["status", "a credential of another kind", { authorization: "Basic c2Nhbg==" }],
    ["browser-observation", "no token", {}],
    ["browser-observation", "a credential of another kind", { authorization: "Basic c2Nhbg==" }],
  ])("are private: the %s of a scan asked with %s is refused", async (what, _with, headers) => {
    const answered = await ask(`/api/v1/scans/${SCAN}/${what}`, { headers });

    expect(answered.status).toBe(401);
    expect(answered.headers.get("cache-control")).toBe("no-store");
    expect((await refusalOf(answered)).code).toBe("unauthorized");
  });

  it.each([
    ["status", "scan_not_found"],
    ["browser-observation", "browser_observation_not_found"],
  ])(
    "answers the %s of an address that is no scan's id as no such scan, in the site's own refusal",
    async (what, code) => {
      vi.stubEnv("APIFY_BROWSER_MODE", "report");

      const answered = await ask(`/api/v1/scans/not-a-scan-id/${what}`, {
        headers: { authorization: "Bearer a-scan-token" },
      });

      expect(answered.status).toBe(404);
      const refused = await refusalOf(answered);
      expect(refused.code).toBe(code);
      expect(refused.retryable).toBe(false);
    },
  );

  it("has no browser observation to show while the observation is not in reports", async () => {
    vi.stubEnv("APIFY_BROWSER_MODE", "shadow");

    const answered = await ask(`/api/v1/scans/${SCAN}/browser-observation`, {
      headers: { authorization: "Bearer a-scan-token" },
    });

    expect(answered.status).toBe(404);
    expect((await refusalOf(answered)).code).toBe("browser_observation_not_found");
  });

  it("answers a HEAD with the refusal's status and no body", async () => {
    const answered = await ask(`/api/v1/scans/${SCAN}/status`, { method: "HEAD" });

    expect(answered.status).toBe(401);
    expect(await answered.text()).toBe("");
  });

  it.each(["status", "browser-observation"])("is read alone: %s", async (what) => {
    const posted = await fromSite(`/api/v1/scans/${SCAN}/${what}`, "POST", {});

    expect(posted.status).toBe(405);
    expect(await allowedAt(`/api/v1/scans/${SCAN}/${what}`)).toBe("GET, HEAD, OPTIONS");
  });
});

describe("publishing a scan's public link", () => {
  const publish = (body: unknown, headers: Record<string, string> = {}) =>
    fromSite(`/api/v1/scans/${SCAN}/share`, "POST", body, headers);

  it("refuses a link asked from another origin", async () => {
    const answered = await publish({}, { origin: "https://elsewhere.example" });

    expect(answered.status).toBe(403);
    expect((await refusalOf(answered)).code).toBe("invalid_origin");
  });

  it("refuses a request it does not understand", async () => {
    const answered = await publish({ allow_indexing: "yes" });

    expect(answered.status).toBe(400);
    expect((await refusalOf(answered)).code).toBe("invalid_share_request");
  });

  it("does not say a scan exists to a visitor who holds neither its token nor a session", async () => {
    const answered = await ask(`/api/v1/scans/${SCAN}/share`, {
      method: "POST",
      headers: { origin: ORIGIN },
    });

    expect(answered.status).toBe(404);
    expect((await refusalOf(answered)).code).toBe("scan_not_found");
  });

  it("says it cannot tell who is visiting, rather than refusing, where the dashboard does not answer", async () => {
    const answered = await publish({}, { cookie: SIGNED_IN });

    expect(answered.status).toBe(503);
    expect(await refusalOf(answered)).toMatchObject({
      code: "visitor_unknown",
      retryable: true,
      retry_after_seconds: 30,
    });
  });

  it("takes a post alone", async () => {
    expect((await ask(`/api/v1/scans/${SCAN}/share`)).status).toBe(405);
    expect(await allowedAt(`/api/v1/scans/${SCAN}/share`)).toBe("OPTIONS, POST");
  });
});

describe("revoking a public link", () => {
  it("refuses a revocation asked from another origin", async () => {
    const answered = await fromSite("/api/v1/shares/a-public-link", "DELETE", undefined, {
      origin: "https://elsewhere.example",
    });

    expect(answered.status).toBe(403);
    expect((await refusalOf(answered)).code).toBe("invalid_origin");
  });

  it("takes a delete alone", async () => {
    expect((await ask("/api/v1/shares/a-public-link")).status).toBe(405);
    expect(await allowedAt("/api/v1/shares/a-public-link")).toBe("DELETE, OPTIONS");
  });
});
