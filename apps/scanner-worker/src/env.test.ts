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

  // A browser mode that is switched on pays for runs at Apify, so it starts
  // only when it can say whose account, which Actor and which build. Each refusal names the setting that is missing, and the one that
  // starts is there so that a check refusing everything cannot pass for one
  // that refuses the right thing.
  const active = {
    ...base,
    APIFY_BROWSER_ENABLED: "true",
    APIFY_BROWSER_MODE: "report",
    APIFY_API_TOKEN: "secret",
    APIFY_BROWSER_ACTOR_ID: "owner/actor",
    APIFY_BROWSER_ACTOR_BUILD: "1.0.42",
  };

  it("starts an active mode that names its token, its Actor and a pinned build", () => {
    for (const mode of ["shadow", "report"]) {
      expect(readWorkerEnv({ ...active, APIFY_BROWSER_MODE: mode }).APIFY_BROWSER_MODE).toBe(mode);
    }
  });

  for (const key of ["APIFY_API_TOKEN", "APIFY_BROWSER_ACTOR_ID", "APIFY_BROWSER_ACTOR_BUILD"]) {
    it(`refuses an active mode without ${key} and names it`, () => {
      for (const mode of ["shadow", "report"]) {
        expect(
          () => readWorkerEnv({ ...active, APIFY_BROWSER_MODE: mode, [key]: undefined }),
          mode,
        ).toThrow(key);
      }
    });
  }

  it("refuses a build name that moves under it", () => {
    for (const build of ["latest", "beta", "dev"]) {
      expect(() => readWorkerEnv({ ...active, APIFY_BROWSER_ACTOR_BUILD: build }), build).toThrow(
        "APIFY_BROWSER_ACTOR_BUILD",
      );
    }
  });
});
