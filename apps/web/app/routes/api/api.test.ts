/**
 * The scanner's API routes, asked of the whole process over HTTP: the
 * liveness probe the image's activation and Docker's health check
 * call, the readiness probe, and the consent route, with the methods each
 * takes and the ones it does not. Nothing here reaches a database: the one it
 * is pointed at listens nowhere.
 */

import { CONSENT_POLICY_VERSION } from "@agentify/analytics/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ask } from "../../../testing/scanner";

const ORIGIN = "https://test.agentify.ad";

beforeEach(() => {
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("APP_BASE_URL", ORIGIN);
  vi.stubEnv("DATABASE_URL", "postgresql://nobody:unused@127.0.0.1:1/nowhere");
  vi.stubEnv("REGISTRATION_ENABLED", "false");
  vi.stubEnv("POSTHOG_BROWSER_KEY", "");
  vi.stubEnv("POSTHOG_BROWSER_HOST", "");
  vi.stubEnv("CARD_SIGNAL_ENABLED", "false");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

/** The error envelope every API refusal carries. */
type Refusal = { error: { code: string; retryable: boolean; retry_after_seconds?: number } };

describe("the liveness probe", () => {
  it("is ok on valid runtime settings without contacting a database, and kept by nobody", async () => {
    const answered = await ask("/api/health/live", {
      headers: { "x-request-id": "0190f4c5-1111-7222-8333-944455556666" },
    });

    expect(answered.status).toBe(200);
    expect(answered.headers.get("content-type")).toMatch(/^application\/json/);
    expect(answered.headers.get("cache-control")).toBe("no-store");
    expect(answered.headers.get("x-request-id")).toBe("0190f4c5-1111-7222-8333-944455556666");
    expect(await answered.json()).toMatchObject({ status: "ok", service: "web" });
  });

  it.each([
    ["REGISTRATION_ENABLED", "flase"],
    ["APP_BASE_URL", "not-an-origin"],
    ["POSTHOG_BROWSER_KEY", "configured-without-a-host"],
    ["ANALYTICS_RUNTIME_ENV", "unknown-environment"],
  ])("refuses invalid %s before the image can be accepted as healthy", async (key, value) => {
    vi.stubEnv(key, value);
    const answered = await ask("/api/health/live");
    const body = await answered.text();

    expect(answered.status).toBe(503);
    expect(JSON.parse(body)).toEqual({ status: "configuration_invalid" });
    expect(body).not.toContain(value);
  });

  it("answers a HEAD with its status and headers and no body", async () => {
    const answered = await ask("/api/health/live", { method: "HEAD" });

    expect(answered.status).toBe(200);
    expect(answered.headers.get("cache-control")).toBe("no-store");
    expect(await answered.text()).toBe("");
  });

  it("refuses a method it does not take with an empty 405, and names the ones it does", async () => {
    const posted = await ask("/api/health/live", { method: "POST" });
    const asked = await ask("/api/health/live", { method: "OPTIONS" });

    expect(posted.status).toBe(405);
    expect(await posted.text()).toBe("");
    expect(asked.status).toBe(204);
    expect(asked.headers.get("allow")).toBe("GET, HEAD, OPTIONS");
  });
});

describe("the readiness probe", () => {
  it("is unavailable, and says the database is, where the database cannot be reached", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});

    const answered = await ask("/api/health");

    expect(answered.status).toBe(503);
    expect(answered.headers.get("cache-control")).toBe("no-store");
    expect(await answered.json()).toMatchObject({
      status: "unavailable",
      service: "web",
      dependencies: { database: "unavailable", scanner_worker: "unknown" },
    });
  });
});

const choice = (categories: Record<string, boolean>) =>
  JSON.stringify({
    policy_version: CONSENT_POLICY_VERSION,
    categories: {
      essential_processing: true,
      product_analytics: false,
      ads_measurement: false,
      marketing_email: false,
      dataset_reuse: false,
      card_signal: false,
      ...categories,
    },
  });

const post = (body: string, headers: Record<string, string> = {}) =>
  ask("/api/v1/consent", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body,
  });

describe("the consent route", () => {
  it.each([
    ["no origin", {}],
    ["another origin", { origin: "https://elsewhere.example" }],
  ])("refuses a choice sent from %s", async (_from, headers) => {
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const answered = await post(choice({}), headers);

    expect(answered.status).toBe(403);
    expect(((await answered.json()) as Refusal).error.code).toBe("origin_forbidden");
  });

  it.each([
    ["is not JSON", "not json"],
    ["names another policy", JSON.stringify({ policy_version: "older", categories: {} })],
    ["claims a category it may not", choice({ marketing_email: true })],
    [
      "carries a field the route does not know",
      JSON.stringify({ ...JSON.parse(choice({})), extra: 1 }),
    ],
  ])("refuses a choice that %s", async (_why, body) => {
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const answered = await post(body, { origin: ORIGIN });

    expect(answered.status).toBe(400);
    expect(((await answered.json()) as Refusal).error.code).toBe("invalid_consent");
  });

  it("says a valid choice could not be saved, and that it may be sent again, where the database cannot be reached", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});

    const answered = await post(choice({ product_analytics: true }), { origin: ORIGIN });

    expect(answered.status).toBe(503);
    expect(answered.headers.get("set-cookie")).toBeNull();
    expect(((await answered.json()) as Refusal).error).toMatchObject({
      code: "consent_unavailable",
      retryable: true,
      retry_after_seconds: 5,
    });
  });

  it("takes a post alone", async () => {
    const read = await ask("/api/v1/consent");
    const asked = await ask("/api/v1/consent", { method: "OPTIONS" });

    expect(read.status).toBe(405);
    expect(await read.text()).toBe("");
    expect(asked.headers.get("allow")).toBe("OPTIONS, POST");
  });
});
