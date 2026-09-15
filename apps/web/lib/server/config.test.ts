import { afterEach, describe, expect, it, vi } from "vitest";

import { getServerConfig } from "./config";
import { getStripeCardSignalConfig } from "./stripe-card-signal-config";

const keys = [
  "APP_BASE_URL",
  "NEXT_PUBLIC_APP_BASE_URL",
  "DATABASE_URL",
  "DASHBOARD_DATABASE_URL",
  "TOKEN_HMAC_SECRET",
  "EMAIL_ENCRYPTION_KEY",
  "EMAIL_PROVIDER",
  "REGISTRATION_ENABLED",
  "SCAN_ACCEPTANCE_ENABLED",
  "LOCAL_EMAIL_EVIDENCE_ENABLED",
  "RESEND_API_KEY",
  "TURNSTILE_ENFORCED",
  "TURNSTILE_SECRET_KEY",
  "NEXT_PUBLIC_TURNSTILE_SITE_KEY",
  "SCANNER_CACHE_ENABLED",
  "BENCHMARK_ENABLED",
  "PUBLIC_SHARE_ENABLED",
  "PARTNER_POSTBACK_ENABLED",
  "CARD_SIGNAL_ENABLED",
  "STRIPE_ADAPTER",
  "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET",
  "NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY",
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
      DATABASE_URL: "postgresql://b2a:b2a@localhost:5432/b2a",
      APP_BASE_URL: "",
      NEXT_PUBLIC_APP_BASE_URL: "",
      TOKEN_HMAC_SECRET: "",
      EMAIL_ENCRYPTION_KEY: "",
      EMAIL_PROVIDER: "local",
      REGISTRATION_ENABLED: "true",
      SCAN_ACCEPTANCE_ENABLED: "true",
      LOCAL_EMAIL_EVIDENCE_ENABLED: "false",
      RESEND_API_KEY: "",
      TURNSTILE_ENFORCED: "false",
      TURNSTILE_SECRET_KEY: "",
      NEXT_PUBLIC_TURNSTILE_SITE_KEY: "",
      SCANNER_CACHE_ENABLED: "false",
      BENCHMARK_ENABLED: "false",
      PUBLIC_SHARE_ENABLED: "false",
      CARD_SIGNAL_ENABLED: "false",
      STRIPE_ADAPTER: "local",
      STRIPE_SECRET_KEY: "",
      STRIPE_WEBHOOK_SECRET: "",
      NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: "",
    });
    const server = getServerConfig();
    expect(server.APP_BASE_URL).toBeUndefined();
    expect(server.TOKEN_HMAC_SECRET).toBeUndefined();
    expect(server.RESEND_API_KEY).toBeUndefined();
    expect(server.appBaseUrl).toBe("http://localhost:3000");
    expect(server.encryptionKey).toHaveLength(32);
    expect(server.SCAN_ACCEPTANCE_ENABLED).toBe(true);

    const stripe = getStripeCardSignalConfig();
    expect(stripe.STRIPE_SECRET_KEY).toBeUndefined();
    expect(stripe.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY).toBeUndefined();
  });

  it("allows an honest registration-off deployment without email credentials", () => {
    Object.assign(process.env, {
      DATABASE_URL: "postgresql://b2a:b2a@localhost:5432/b2a",
      EMAIL_PROVIDER: "disabled",
      REGISTRATION_ENABLED: "false",
      RESEND_API_KEY: "",
    });
    const config = getServerConfig();
    expect(config.EMAIL_PROVIDER).toBe("disabled");
    expect(config.REGISTRATION_ENABLED).toBe(false);
  });

  it("allows registration with local mail and no hosted auth credentials", () => {
    Object.assign(process.env, {
      DATABASE_URL: "postgresql://b2a:b2a@localhost:5432/b2a",
      EMAIL_PROVIDER: "local",
      REGISTRATION_ENABLED: "true",
    });
    expect(getServerConfig().REGISTRATION_ENABLED).toBe(true);
  });

  it("refuses production registration with disabled mail", () => {
    Object.assign(process.env, {
      DATABASE_URL: "postgresql://b2a:b2a@localhost:5432/b2a",
      EMAIL_PROVIDER: "disabled",
      REGISTRATION_ENABLED: "true",
    });
    vi.stubEnv("NODE_ENV", "production");
    expect(() => getServerConfig()).toThrow(
      "registration_requires_email_delivery",
    );
  });

  it("supports the production scan acceptance kill-switch", () => {
    Object.assign(process.env, {
      DATABASE_URL: "postgresql://b2a:b2a@localhost:5432/b2a",
      SCAN_ACCEPTANCE_ENABLED: "false",
      REGISTRATION_ENABLED: "false",
    });
    expect(getServerConfig().SCAN_ACCEPTANCE_ENABLED).toBe(false);
  });

  it("rejects incomplete enforced Turnstile configuration", () => {
    Object.assign(process.env, {
      DATABASE_URL: "postgresql://b2a:b2a@localhost:5432/b2a",
      TURNSTILE_ENFORCED: "true",
      TURNSTILE_SECRET_KEY: "secret",
      NEXT_PUBLIC_TURNSTILE_SITE_KEY: "",
      REGISTRATION_ENABLED: "false",
    });
    expect(() => getServerConfig()).toThrow(
      "turnstile_enforcement_requires_both_keys",
    );
  });
});
