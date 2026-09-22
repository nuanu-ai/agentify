import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const entrypoint = new URL("../deploy/droplet/web-entrypoint.sh", import.meta.url).pathname;

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
      DATABASE_URL:
        "postgresql://agentify_web:synthetic@agentify-scanner-postgres:5432/agentify_scanner",
      TOKEN_HMAC_SECRET: "synthetic-hmac-key-000000000000000000000000",
      CABINET_IDENTITY_URL: "http://agentify-cabinet-identity:3002",
      REPORT_IDENTITY_SECRET: "synthetic-report-identity-secret-32-bytes",
      ...overrides,
    },
  });
}

test("web entrypoint starts registration with its private cabinet identity route and without a mail credential", () => {
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

test("web entrypoint refuses enabled registration without its cabinet identity route", () => {
  const result = runEntrypoint({ CABINET_IDENTITY_URL: "" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /CABINET_IDENTITY_URL/);
});

test("web entrypoint refuses enabled registration without its dedicated identity credential", () => {
  const result = runEntrypoint({ REPORT_IDENTITY_SECRET: "" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /REPORT_IDENTITY_SECRET/);
});

test("web entrypoint refuses a short identity credential without printing its value", () => {
  const result = runEntrypoint({ REPORT_IDENTITY_SECRET: "secret-marker" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /REPORT_IDENTITY_SECRET/);
  assert.ok(!result.stderr.includes("secret-marker"));
});
