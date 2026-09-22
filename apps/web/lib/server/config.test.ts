import { afterEach, describe, expect, it, vi } from "vitest";

import { getServerConfig } from "./config";
import { getStripeCardSignalConfig } from "./stripe-card-signal-config";

const keys = [
  "APP_BASE_URL",
  "DATABASE_URL",
  "DASHBOARD_DATABASE_URL",
  "TOKEN_HMAC_SECRET",
  "EMAIL_ENCRYPTION_KEY",
  "REGISTRATION_ENABLED",
  "SCAN_ACCEPTANCE_ENABLED",
  "TURNSTILE_ENFORCED",
  "TURNSTILE_SECRET_KEY",
  "TURNSTILE_SITE_KEY",
  "CABINET_IDENTITY_URL",
  "REPORT_IDENTITY_SECRET",
  "SCANNER_CACHE_ENABLED",
  "BENCHMARK_ENABLED",
  "PUBLIC_SHARE_ENABLED",
  "PARTNER_POSTBACK_ENABLED",
  "CARD_SIGNAL_ENABLED",
  "STRIPE_ADAPTER",
  "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET",
  "STRIPE_PUBLISHABLE_KEY",
] as const;
const original = Object.fromEntries(keys.map((key) => [key, process.env[key]]));

afterEach(() => {
  vi.unstubAllEnvs();
  for (const key of keys) {
    const value = original[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("clean-clone environment", () => {
  it("treats optional empty .env.example values as absent", () => {
    Object.assign(process.env, {
      DATABASE_URL:
        "postgresql://agentify_scanner:agentify_scanner@localhost:5432/agentify_scanner",
      APP_BASE_URL: "",
      TOKEN_HMAC_SECRET: "",
      EMAIL_ENCRYPTION_KEY: "",
      REGISTRATION_ENABLED: "true",
      SCAN_ACCEPTANCE_ENABLED: "true",
      TURNSTILE_ENFORCED: "false",
      TURNSTILE_SECRET_KEY: "",
      TURNSTILE_SITE_KEY: "",
      CABINET_IDENTITY_URL: "",
      REPORT_IDENTITY_SECRET: "",
      SCANNER_CACHE_ENABLED: "false",
      BENCHMARK_ENABLED: "false",
      PUBLIC_SHARE_ENABLED: "false",
      CARD_SIGNAL_ENABLED: "false",
      STRIPE_ADAPTER: "local",
      STRIPE_SECRET_KEY: "",
      STRIPE_WEBHOOK_SECRET: "",
      STRIPE_PUBLISHABLE_KEY: "",
    });
    const server = getServerConfig();
    expect(server.APP_BASE_URL).toBeUndefined();
    expect(server.TOKEN_HMAC_SECRET).toBeUndefined();
    expect(server.appBaseUrl).toBe("http://localhost:3000");
    expect(server.encryptionKey).toHaveLength(32);
    expect(server.SCAN_ACCEPTANCE_ENABLED).toBe(true);

    const stripe = getStripeCardSignalConfig();
    expect(stripe.STRIPE_SECRET_KEY).toBeUndefined();
    expect(stripe.STRIPE_PUBLISHABLE_KEY).toBeUndefined();
  });

  it("allows an honest registration-off local deployment without cabinet credentials", () => {
    Object.assign(process.env, {
      DATABASE_URL:
        "postgresql://agentify_scanner:agentify_scanner@localhost:5432/agentify_scanner",
      REGISTRATION_ENABLED: "false",
    });
    const config = getServerConfig();
    expect(config.REGISTRATION_ENABLED).toBe(false);
  });

  it("allows registration against a configured local cabinet", () => {
    Object.assign(process.env, {
      DATABASE_URL:
        "postgresql://agentify_scanner:agentify_scanner@localhost:5432/agentify_scanner",
      REGISTRATION_ENABLED: "true",
      CABINET_IDENTITY_URL: "http://cabinet.internal:3002",
      REPORT_IDENTITY_SECRET: "r".repeat(32),
    });
    expect(getServerConfig().REGISTRATION_ENABLED).toBe(true);
  });

  it("supports the production scan acceptance kill-switch", () => {
    Object.assign(process.env, {
      DATABASE_URL:
        "postgresql://agentify_scanner:agentify_scanner@localhost:5432/agentify_scanner",
      SCAN_ACCEPTANCE_ENABLED: "false",
      REGISTRATION_ENABLED: "false",
    });
    expect(getServerConfig().SCAN_ACCEPTANCE_ENABLED).toBe(false);
  });

  it("allows production privacy cleanup with registration disabled and no cabinet credentials", () => {
    vi.stubEnv("NODE_ENV", "production");
    Object.assign(process.env, {
      DATABASE_URL:
        "postgresql://agentify_scanner:agentify_scanner@localhost:5432/agentify_scanner",
      TOKEN_HMAC_SECRET: "h".repeat(32),
      REGISTRATION_ENABLED: "false",
      CABINET_IDENTITY_URL: "",
      REPORT_IDENTITY_SECRET: "",
    });
    expect(getServerConfig()).toMatchObject({
      production: true,
      REGISTRATION_ENABLED: false,
      CABINET_IDENTITY_URL: undefined,
      REPORT_IDENTITY_SECRET: undefined,
    });
  });

  it("fails closed when production registration lacks cabinet credentials", () => {
    vi.stubEnv("NODE_ENV", "production");
    Object.assign(process.env, {
      DATABASE_URL:
        "postgresql://agentify_scanner:agentify_scanner@localhost:5432/agentify_scanner",
      TOKEN_HMAC_SECRET: "h".repeat(32),
      REGISTRATION_ENABLED: "true",
      CABINET_IDENTITY_URL: "",
      REPORT_IDENTITY_SECRET: "",
    });
    expect(() => getServerConfig()).toThrow("cabinet_identity_configuration_missing");
  });

  it("rejects incomplete enforced Turnstile configuration", () => {
    Object.assign(process.env, {
      DATABASE_URL:
        "postgresql://agentify_scanner:agentify_scanner@localhost:5432/agentify_scanner",
      TURNSTILE_ENFORCED: "true",
      TURNSTILE_SECRET_KEY: "secret",
      TURNSTILE_SITE_KEY: "",
      REGISTRATION_ENABLED: "false",
    });
    expect(() => getServerConfig()).toThrow("turnstile_enforcement_requires_both_keys");
  });

  it("requires the cabinet identity URL and dedicated secret together", () => {
    Object.assign(process.env, {
      DATABASE_URL:
        "postgresql://agentify_scanner:agentify_scanner@localhost:5432/agentify_scanner",
      CABINET_IDENTITY_URL: "http://cabinet.internal:3002",
      REPORT_IDENTITY_SECRET: "",
    });
    expect(() => getServerConfig()).toThrow("cabinet_identity_url_and_secret_required_together");
  });
});
