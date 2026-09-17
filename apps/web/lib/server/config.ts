import { createHash } from "node:crypto";

import { z } from "zod";

const booleanEnv = z
  .enum(["true", "false"])
  .default("false")
  .transform((value) => value === "true");

const optionalNonEmpty = <T extends z.ZodType>(schema: T) =>
  z.preprocess(
    (value) => (value === "" ? undefined : value),
    schema.optional(),
  );

const schema = z.object({
  APP_BASE_URL: optionalNonEmpty(z.url({ protocol: /^https?$/ })),
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
  DASHBOARD_DATABASE_URL: optionalNonEmpty(
    z.url({ protocol: /^postgres(ql)?$/ }),
  ),
  TOKEN_HMAC_SECRET: optionalNonEmpty(z.string().min(32)),
  EMAIL_ENCRYPTION_KEY: optionalNonEmpty(z.string()),
  REGISTRATION_ENABLED: z
    .enum(["true", "false"])
    .default("true")
    .transform((value) => value === "true"),
  SCAN_ACCEPTANCE_ENABLED: z
    .enum(["true", "false"])
    .default("true")
    .transform((value) => value === "true"),
  TURNSTILE_ENFORCED: booleanEnv,
  TURNSTILE_SECRET_KEY: optionalNonEmpty(z.string().min(1)),
  TURNSTILE_SITE_KEY: optionalNonEmpty(z.string().min(1)),
  CABINET_IDENTITY_URL: optionalNonEmpty(z.url({ protocol: /^https?$/ })),
  REPORT_IDENTITY_SECRET: optionalNonEmpty(z.string().min(32)),
  SCANNER_CACHE_ENABLED: booleanEnv,
  BENCHMARK_ENABLED: booleanEnv,
  PUBLIC_SHARE_ENABLED: booleanEnv,
  PARTNER_POSTBACK_ENABLED: booleanEnv,
  APIFY_BROWSER_MODE: z.enum(["off", "shadow", "report"]).default("off"),
  REMEDIATION_PROMPT_ENABLED: z
    .enum(["true", "false"])
    .default("true")
    .transform((value) => value === "true"),
});

export type ServerConfig = ReturnType<typeof getServerConfig>;

export function getServerConfig() {
  const parsed = schema.parse(process.env);
  const production = process.env.NODE_ENV === "production";
  if (
    parsed.TURNSTILE_ENFORCED &&
    (!parsed.TURNSTILE_SECRET_KEY || !parsed.TURNSTILE_SITE_KEY)
  ) {
    throw new Error("turnstile_enforcement_requires_both_keys");
  }
  if (
    Boolean(parsed.CABINET_IDENTITY_URL) !==
    Boolean(parsed.REPORT_IDENTITY_SECRET)
  ) {
    throw new Error("cabinet_identity_url_and_secret_required_together");
  }
  if (
    production &&
    parsed.REGISTRATION_ENABLED &&
    (!parsed.CABINET_IDENTITY_URL || !parsed.REPORT_IDENTITY_SECRET)
  ) {
    throw new Error("cabinet_identity_configuration_missing");
  }
  if (production && !parsed.TOKEN_HMAC_SECRET) {
    throw new Error("token_hmac_secret_missing");
  }
  const hmacSecret =
    parsed.TOKEN_HMAC_SECRET ??
    "local-development-hmac-secret-change-before-production";
  const encryptionKey = parsed.EMAIL_ENCRYPTION_KEY
    ? Buffer.from(parsed.EMAIL_ENCRYPTION_KEY, "base64")
    : createHash("sha256").update(`${hmacSecret}:local-email-key`).digest();
  if (encryptionKey.length !== 32)
    throw new Error("email_encryption_key_must_be_32_bytes_base64");

  return {
    ...parsed,
    appBaseUrl: parsed.APP_BASE_URL ?? "http://localhost:3000",
    hmacSecret,
    encryptionKey,
    production,
  };
}
