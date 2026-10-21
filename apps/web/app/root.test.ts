import { afterEach, describe, expect, it } from "vitest";
import { loader } from "./root";

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
});

describe("browser-visible runtime configuration", () => {
  it("reads the legal and contact claims from the environment the process runs with", () => {
    Object.assign(process.env, {
      APP_BASE_URL: "https://test.agentify.ad",
      PRIVACY_EMAIL: "privacy-test@example.com",
      ABUSE_EMAIL: "abuse-test@example.com",
      LEGAL_OPERATOR: "Test operator",
      LEGAL_IDENTITY_CONFIRMED: "true",
    });

    expect(loader().app).toMatchObject({
      displayBrand: "Agentify",
      baseUrl: "https://test.agentify.ad",
      privacyEmail: "privacy-test@example.com",
      abuseEmail: "abuse-test@example.com",
      legalOperator: "Test operator",
      legalIdentityConfirmed: true,
    });
  });

  it("hands the browser the analytics destinations the server was given", () => {
    Object.assign(process.env, {
      ANALYTICS_RUNTIME_ENV: "test",
      POSTHOG_BROWSER_KEY: "phc_runtime_test",
      POSTHOG_BROWSER_HOST: "https://posthog.test.example",
      POSTHOG_DESTINATION_ENV: "test",
      META_PIXEL_ID: "meta-runtime-test",
      META_DESTINATION_ENV: "test",
    });

    expect(loader().analytics).toEqual({
      runtimeEnvironment: "test",
      posthog: {
        key: "phc_runtime_test",
        host: "https://posthog.test.example",
        destinationEnvironment: "test",
      },
      meta: {
        pixelId: "meta-runtime-test",
        destinationEnvironment: "test",
      },
    });
  });

  it("refuses a browser PostHog key without its runtime host", () => {
    Object.assign(process.env, {
      POSTHOG_BROWSER_KEY: "phc_runtime_test",
      POSTHOG_BROWSER_HOST: "",
    });

    expect(() => loader()).toThrow("browser_posthog_requires_key_and_host");
  });
});
