#!/usr/bin/env node

import { readFile, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";

const image = process.argv[2];
const postgresImage = process.argv[3] ?? "postgres:17-alpine";
if (!image) {
  process.stderr.write(
    "Usage: node ops/scripts/web-runtime-image-smoke.mjs <web-image> [postgres-image]\n",
  );
  process.exit(2);
}

const suffix = `${process.pid}-${Date.now()}`;
const prefix = `agentify-runtime-smoke-${suffix}`;
const network = `${prefix}-net`;
const postgres = `${prefix}-postgres`;
const testWeb = `${prefix}-test`;
const productionWeb = `${prefix}-production`;
const evidenceFile = `/tmp/${prefix}-evidence.json`;
const createdContainers = [];

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: new URL("../..", import.meta.url),
    encoding: "utf8",
    stdio: options.quiet ? "pipe" : "inherit",
    env: options.env ?? process.env,
  });
  if (result.status !== 0) {
    if (options.quiet && options.showFailure !== false) {
      process.stderr.write(result.stdout ?? "");
      process.stderr.write(result.stderr ?? "");
    }
    throw new Error(options.error ?? `${command} exited with ${result.status}`);
  }
  return result.stdout?.trim() ?? "";
}

function docker(args, options = {}) {
  return run("docker", args, options);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function publishedPort(container, internalPort) {
  const mapping = docker(
    ["container", "port", container, `${internalPort}/tcp`],
    { quiet: true, error: "Docker did not publish the expected port" },
  );
  const port = mapping.match(/:(\d+)$/)?.[1];
  assert(port, `Could not parse the published port for ${internalPort}`);
  return port;
}

async function waitFor(check, description) {
  let lastError;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(
    `${description} did not become ready${lastError ? `: ${lastError.message}` : ""}`,
  );
}

async function getText(baseUrl, path, cookie) {
  const response = await fetch(`${baseUrl}${path}`, {
    headers: cookie ? { Cookie: cookie } : undefined,
    redirect: "manual",
  });
  const body = await response.text();
  assert(response.ok, `${path} returned HTTP ${response.status}`);
  return body;
}

function assertIncludes(body, expected, description) {
  assert(body.includes(expected), `${description} was absent`);
}

function assertExcludes(body, unexpected, description) {
  assert(
    !body.includes(unexpected),
    `${description} leaked from the other runtime`,
  );
}

function webEnvironment(channel, databaseUrl) {
  const isTest = channel === "test";
  const label = isTest ? "test-runtime" : "production-runtime";
  return {
    APP_BASE_URL: isTest
      ? "https://test-runtime.agentify.example"
      : "https://production-runtime.agentify.example",
    DATABASE_URL: databaseUrl,
    TOKEN_HMAC_SECRET: "runtime-smoke-hmac-secret-32-bytes-minimum",
    EMAIL_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
    REGISTRATION_ENABLED: isTest ? "false" : "true",
    CABINET_IDENTITY_URL: "http://identity-not-used-by-runtime-smoke.invalid:3002",
    REPORT_IDENTITY_SECRET: "runtime-smoke-report-identity-secret-32-bytes",
    PRIVACY_EMAIL: `privacy-${label}@example.com`,
    ABUSE_EMAIL: `abuse-${label}@example.com`,
    LEGAL_OPERATOR: `${label} legal operator`,
    LEGAL_IDENTITY_CONFIRMED: isTest ? "false" : "true",
    TURNSTILE_SITE_KEY: `turnstile-${label}`,
    ANALYTICS_RUNTIME_ENV: isTest ? "test" : "production",
    POSTHOG_BROWSER_KEY: `posthog-${label}`,
    POSTHOG_BROWSER_HOST: `https://posthog-${label}.example.com`,
    POSTHOG_DESTINATION_ENV: isTest ? "preview" : "production",
    META_PIXEL_ID: `meta-${label}`,
    META_DESTINATION_ENV: isTest ? "local" : "preview",
    CARD_SIGNAL_ENABLED: "true",
    STRIPE_ADAPTER: "stripe",
    STRIPE_SECRET_KEY: `stripe-secret-${label}`,
    STRIPE_WEBHOOK_SECRET: `stripe-webhook-${label}`,
    STRIPE_PUBLISHABLE_KEY: `stripe-publishable-${label}`,
  };
}

function startWeb(name, environment) {
  const environmentArgs = Object.entries(environment).flatMap(
    ([key, value]) => ["-e", `${key}=${value}`],
  );
  docker(
    [
      "run",
      "--detach",
      "--name",
      name,
      "--network",
      network,
      "--publish",
      "127.0.0.1::3000",
      ...environmentArgs,
      image,
    ],
    { quiet: true, error: "Web container failed to start" },
  );
  createdContainers.push(name);
}

async function assertRuntime(baseUrl, channel, reportPath, reportCookie) {
  const isTest = channel === "test";
  const own = isTest ? "test-runtime" : "production-runtime";
  const other = isTest ? "production-runtime" : "test-runtime";
  const origin = isTest
    ? "https://test-runtime.agentify.example"
    : "https://production-runtime.agentify.example";

  const [robots, sitemap, llms, owner, privacy, scan, pending, report] =
    await Promise.all([
      getText(baseUrl, "/robots.txt"),
      getText(baseUrl, "/sitemap.xml"),
      getText(baseUrl, "/llms.txt"),
      getText(baseUrl, "/owner"),
      getText(baseUrl, "/privacy"),
      getText(baseUrl, "/scan/runtime-smoke"),
      getText(baseUrl, "/scan/pending"),
      getText(baseUrl, reportPath, reportCookie),
    ]);

  assertIncludes(
    robots,
    `Sitemap: ${origin}/sitemap.xml`,
    `${channel} robots origin`,
  );
  assertIncludes(
    sitemap,
    `<loc>${origin}/owner</loc>`,
    `${channel} sitemap origin`,
  );
  assertIncludes(llms, `](${origin}/owner)`, `${channel} llms origin`);
  assertIncludes(owner, `${origin}/owner`, `${channel} canonical metadata`);
  assertIncludes(owner, `posthog-${own}`, `${channel} PostHog key`);
  assertIncludes(
    owner,
    `posthog-${own}.example.com`,
    `${channel} PostHog host`,
  );
  assertIncludes(owner, `meta-${own}`, `${channel} Meta destination`);
  const serializedOwner = owner.replaceAll("\\", "");
  assert(
    new RegExp(
      `posthog.{0,240}destinationEnvironment.{0,30}${isTest ? "preview" : "production"}`,
    ).test(serializedOwner),
    `${channel} PostHog destination environment was absent`,
  );
  assert(
    new RegExp(
      `meta.{0,240}destinationEnvironment.{0,30}${isTest ? "local" : "preview"}`,
    ).test(serializedOwner),
    `${channel} Meta destination environment was absent`,
  );
  assertIncludes(owner, `abuse-${own}@example.com`, `${channel} abuse contact`);
  assertExcludes(owner, other, `${channel} analytics configuration`);
  assertIncludes(
    privacy,
    `privacy-${own}@example.com`,
    `${channel} privacy contact`,
  );
  assertIncludes(privacy, `${own} legal operator`, `${channel} legal operator`);
  const pendingLegalIdentity =
    "Final legal identity, jurisdiction-specific lawful basis";
  if (isTest)
    assertIncludes(privacy, pendingLegalIdentity, `${channel} legal status`);
  else assertExcludes(privacy, pendingLegalIdentity, `${channel} legal status`);
  assertExcludes(privacy, other, `${channel} legal configuration`);
  assert(
    new RegExp(`registrationEnabled.{0,12}${isTest ? "false" : "true"}`).test(
      scan,
    ),
    `${channel} registration flag was absent`,
  );
  assertIncludes(pending, `turnstile-${own}`, `${channel} Turnstile site key`);
  assertExcludes(pending, other, `${channel} Turnstile configuration`);
  assertIncludes(
    report,
    `stripe-publishable-${own}`,
    `${channel} Stripe publishable key`,
  );
  assertExcludes(report, other, `${channel} Stripe configuration`);
}

async function main() {
  const imageId = docker(["image", "inspect", "--format", "{{.Id}}", image], {
    quiet: true,
    error: "The requested web image does not exist",
  });
  docker(["network", "create", network], { quiet: true });

  docker(
    [
      "run",
      "--detach",
      "--name",
      postgres,
      "--network",
      network,
      "--network-alias",
      "postgres",
      "--publish",
      "127.0.0.1::5432",
      "-e",
      "POSTGRES_DB=agentify_runtime_smoke",
      "-e",
      "POSTGRES_USER=agentify_runtime_smoke",
      "-e",
      "POSTGRES_PASSWORD=runtime-smoke-password",
      postgresImage,
    ],
    { quiet: true, error: "PostgreSQL fixture failed to start" },
  );
  createdContainers.push(postgres);

  await waitFor(
    () =>
      docker(["exec", postgres, "pg_isready", "-U", "agentify_runtime_smoke"], {
        quiet: true,
        showFailure: false,
        error: "PostgreSQL is not ready",
      }),
    "PostgreSQL",
  );

  const postgresPort = publishedPort(postgres, 5432);
  const localDatabaseUrl = `postgresql://agentify_runtime_smoke:runtime-smoke-password@127.0.0.1:${postgresPort}/agentify_runtime_smoke`;
  const containerDatabaseUrl =
    "postgresql://agentify_runtime_smoke:runtime-smoke-password@postgres:5432/agentify_runtime_smoke";
  const seedEnvironment = {
    ...process.env,
    APP_BASE_URL: "http://runtime-smoke.invalid",
    DATABASE_URL: localDatabaseUrl,
    TOKEN_HMAC_SECRET: "runtime-smoke-hmac-secret-32-bytes-minimum",
    EMAIL_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
    REGISTRATION_ENABLED: "true",
    LOCAL_E2E_FIXTURE_ACK: "yes",
    LOCAL_E2E_VERIFICATION_FILE: evidenceFile,
  };
  run("pnpm", ["--filter", "@agentify/scanner-database", "db:migrate"], {
    quiet: true,
    env: seedEnvironment,
    error: "Database migration failed",
  });
  run("pnpm", ["--filter", "@agentify/web", "prebuild"], {
    quiet: true,
    error: "Web dependency preparation failed",
  });
  run("pnpm", ["--filter", "@agentify/web", "e2e:seed"], {
    quiet: true,
    env: seedEnvironment,
    error: "Browser evidence seed failed",
  });
  const evidence = JSON.parse(await readFile(evidenceFile, "utf8"));
  const reportPath = new URL(evidence.reportUrl).pathname;
  const reportCookie = `b2a_report_session=${evidence.reportSessionToken}`;

  startWeb(testWeb, webEnvironment("test", containerDatabaseUrl));
  startWeb(productionWeb, webEnvironment("production", containerDatabaseUrl));
  const testImageId = docker(["inspect", "--format", "{{.Image}}", testWeb], {
    quiet: true,
  });
  const productionImageId = docker(
    ["inspect", "--format", "{{.Image}}", productionWeb],
    { quiet: true },
  );
  assert(
    testImageId === imageId,
    "Test runtime did not use the requested image",
  );
  assert(
    productionImageId === imageId,
    "Production runtime did not use the requested image",
  );
  assert(testImageId === productionImageId, "Runtime image identities differ");

  const testBaseUrl = `http://127.0.0.1:${publishedPort(testWeb, 3000)}`;
  const productionBaseUrl = `http://127.0.0.1:${publishedPort(productionWeb, 3000)}`;
  await Promise.all([
    waitFor(() => getText(testBaseUrl, "/api/health/live"), "test web runtime"),
    waitFor(
      () => getText(productionBaseUrl, "/api/health/live"),
      "production web runtime",
    ),
  ]);
  await Promise.all([
    assertRuntime(testBaseUrl, "test", reportPath, reportCookie),
    assertRuntime(productionBaseUrl, "production", reportPath, reportCookie),
  ]);
  for (const [label, overrides] of [
    ["bad-registration", { REGISTRATION_ENABLED: "flase" }],
    [
      "bad-analytics",
      { POSTHOG_BROWSER_KEY: "public-key", POSTHOG_BROWSER_HOST: "" },
    ],
  ]) {
    const name = `${prefix}-${label}`;
    startWeb(name, {
      ...webEnvironment("test", containerDatabaseUrl),
      ...overrides,
    });
    await waitFor(async () => {
      const state = JSON.parse(
        docker(["inspect", "--format", "{{json .State}}", name], {
          quiet: true,
        }),
      );
      if (!state.Running) {
        assert(
          state.ExitCode !== 0,
          "Invalid configuration exited successfully",
        );
        return true;
      }
      const base = `http://127.0.0.1:${publishedPort(name, 3000)}`;
      let response;
      try {
        response = await fetch(`${base}/api/health/live`);
      } catch {
        return false;
      }
      assert(
        response.status === 503,
        "Invalid runtime configuration was accepted as healthy",
      );
      return true;
    }, label);
  }
  process.stdout.write(
    "PASS: one web image serves distinct test and production public runtime configuration.\n",
  );
}

try {
  await main();
} finally {
  for (const container of createdContainers.reverse()) {
    spawnSync("docker", ["rm", "--force", container], { stdio: "ignore" });
  }
  spawnSync("docker", ["network", "rm", network], { stdio: "ignore" });
  await rm(evidenceFile, { force: true });
}
