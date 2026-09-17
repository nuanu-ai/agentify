import { afterEach, describe, expect, it } from "vitest";

import RootLayout from "./layout";
import { getPublicAppConfig } from "../lib/app-config";
import { getCardSignalPublicConfig } from "../lib/server/stripe-card-signal-config";

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
});

function analyticsConfigFromLayout() {
  const layout = RootLayout({ children: null });
  const body = layout.props.children;
  const analytics = body.props.children[1];
  return analytics.props.config;
}

describe("browser-visible runtime configuration", () => {
  it("reads legal and contact claims from ordinary runtime variables", () => {
    Object.assign(process.env, {
      APP_BASE_URL: "https://test.agentify.ad",
      PRIVACY_EMAIL: "privacy-test@example.com",
      ABUSE_EMAIL: "abuse-test@example.com",
      LEGAL_OPERATOR: "Test operator",
      LEGAL_IDENTITY_CONFIRMED: "true",
    });

    expect(getPublicAppConfig()).toMatchObject({
      displayBrand: "Agentify",
      baseUrl: "https://test.agentify.ad",
      privacyEmail: "privacy-test@example.com",
      abuseEmail: "abuse-test@example.com",
      legalOperator: "Test operator",
      legalIdentityConfirmed: true,
    });
  });

  it("passes analytics destinations from the server into the client runtime", () => {
    Object.assign(process.env, {
      ANALYTICS_RUNTIME_ENV: "test",
      POSTHOG_BROWSER_KEY: "phc_runtime_test",
      POSTHOG_BROWSER_HOST: "https://posthog.test.example",
      POSTHOG_DESTINATION_ENV: "test",
      META_PIXEL_ID: "meta-runtime-test",
      META_DESTINATION_ENV: "test",
    });

    expect(analyticsConfigFromLayout()).toEqual({
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

    expect(() => RootLayout({ children: null })).toThrow(
      "browser_posthog_requires_key_and_host",
    );
  });

  it("passes the Stripe publishable key through the authenticated report server boundary", () => {
    Object.assign(process.env, {
      CARD_SIGNAL_ENABLED: "false",
      STRIPE_ADAPTER: "local",
      STRIPE_PUBLISHABLE_KEY: "pk_runtime_test",
    });

    expect(getCardSignalPublicConfig().publishableKey).toBe("pk_runtime_test");
  });
});
