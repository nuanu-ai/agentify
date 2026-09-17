import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const entrypoint = new URL(
  "../deploy/droplet/web-entrypoint.sh",
  import.meta.url,
).pathname;

function runEntrypoint(overrides = {}) {
  const directory = mkdtempSync(join(tmpdir(), "agentify-web-entrypoint-"));
  const command = join(directory, "command.sh");
  writeFileSync(command, "#!/bin/sh\nexit 0\n");
  chmodSync(command, 0o700);
  return spawnSync("/bin/sh", [entrypoint, command], {
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      REGISTRATION_ENABLED: "true",
      APP_BASE_URL: "https://agentify.ad",
      DATABASE_URL: "postgresql://agentify_web:synthetic@agentify-scanner-postgres:5432/agentify_scanner",
      TOKEN_HMAC_SECRET: "synthetic-hmac-key-000000000000000000000000",
      EMAIL_PROVIDER: "resend",
      RESEND_API_KEY: "synthetic-resend-key",
      RESEND_FROM: "reports@agentify.ad",
      ...overrides,
    },
  });
}

test("web entrypoint starts registration with private DB and Resend, without Supabase Auth", () => {
  const result = runEntrypoint();
  assert.equal(result.status, 0, result.stderr);
});

test("web entrypoint starts the same artifact with registration disabled", () => {
  const result = runEntrypoint({ REGISTRATION_ENABLED: "false" });
  assert.equal(result.status, 0, result.stderr);
});

test("web entrypoint requires the public runtime origin", () => {
  const result = runEntrypoint({ APP_BASE_URL: "" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /APP_BASE_URL/);
});

test("web entrypoint refuses enabled registration without a production mail provider", () => {
  const result = runEntrypoint({ EMAIL_PROVIDER: "disabled" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /production mail provider/);
});

test("web entrypoint refuses enabled registration without the Resend key", () => {
  const result = runEntrypoint({ RESEND_API_KEY: "" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /RESEND_API_KEY/);
});
