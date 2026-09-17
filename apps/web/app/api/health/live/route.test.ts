import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GET } from "./route";

beforeEach(() => {
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("APP_BASE_URL", "https://test.agentify.ad");
  vi.stubEnv("DATABASE_URL", "postgresql://test:test@localhost/test");
  vi.stubEnv("REGISTRATION_ENABLED", "false");
  vi.stubEnv("EMAIL_PROVIDER", "disabled");
  vi.stubEnv("POSTHOG_BROWSER_KEY", "");
  vi.stubEnv("POSTHOG_BROWSER_HOST", "");
  vi.stubEnv("CARD_SIGNAL_ENABLED", "false");
});
afterEach(() => vi.unstubAllEnvs());

describe("web configuration readiness", () => {
  it("accepts valid runtime settings without contacting a database", () => {
    expect(
      GET(new Request("https://test.agentify.ad/api/health/live")).status,
    ).toBe(200);
  });
  it.each([
    ["REGISTRATION_ENABLED", "flase"],
    ["APP_BASE_URL", "not-an-origin"],
    ["POSTHOG_BROWSER_KEY", "configured-without-a-host"],
    ["ANALYTICS_RUNTIME_ENV", "unknown-environment"],
  ])(
    "refuses invalid %s before the image can be accepted as healthy",
    async (key, value) => {
      vi.stubEnv(key, value);
      const response = GET(
        new Request("https://test.agentify.ad/api/health/live"),
      );
      expect(response.status).toBe(503);
      expect(await response.text()).not.toContain(value);
    },
  );
});
