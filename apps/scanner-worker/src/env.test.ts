import { describe, expect, it } from "vitest";

import { readWorkerEnv } from "./env.js";

const base = {
  DATABASE_URL: "postgresql://localhost/agentify",
  APP_BASE_URL: "https://agentify.ad",
};

describe("browser observation worker env", () => {
  it("defaults fail-safe to off", () => {
    const env = readWorkerEnv(base);
    expect(env.APIFY_BROWSER_ENABLED).toBe(false);
    expect(env.APIFY_BROWSER_MODE).toBe("off");
    expect(env.PARTNER_POSTBACK_ENABLED).toBe(false);
  });

  it("requires a server-only secret when partner delivery is active", () => {
    expect(() =>
      readWorkerEnv({
        ...base,
        PARTNER_POSTBACK_ENABLED: "true",
      }),
    ).toThrow("PARTNER_POSTBACK_SECRET");
    expect(
      readWorkerEnv({
        ...base,
        PARTNER_POSTBACK_ENABLED: "true",
        PARTNER_POSTBACK_SECRET: "partner-secret-value",
      }).PARTNER_POSTBACK_ENABLED,
    ).toBe(true);
  });

  it("requires token, actor and immutable build for active modes", () => {
    expect(() =>
      readWorkerEnv({
        ...base,
        APIFY_BROWSER_ENABLED: "true",
        APIFY_BROWSER_MODE: "shadow",
      }),
    ).toThrow();
    expect(() =>
      readWorkerEnv({
        ...base,
        APIFY_BROWSER_ENABLED: "true",
        APIFY_BROWSER_MODE: "report",
        APIFY_API_TOKEN: "secret",
        APIFY_BROWSER_ACTOR_ID: "owner/actor",
        APIFY_BROWSER_ACTOR_BUILD: "latest",
      }),
    ).toThrow();
  });
});
