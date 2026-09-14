import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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
  const flagFile = join(directory, "registration-flag");
  const fingerprintFile = join(directory, "auth-fingerprint");
  const command = join(directory, "command.sh");
  const authUrl = "https://project.supabase.co";
  const authKey = "sb_publishable_test_key_12345678901234567890";
  writeFileSync(flagFile, "true\n");
  writeFileSync(
    fingerprintFile,
    `${createHash("sha256").update(`${authUrl}\0${authKey}`).digest("hex")}\n`,
  );
  writeFileSync(command, "#!/bin/sh\nexit 0\n");
  chmodSync(command, 0o700);
  return spawnSync("/bin/sh", [entrypoint, command], {
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      REGISTRATION_BUILD_FLAG_FILE: flagFile,
      SUPABASE_AUTH_BUILD_FINGERPRINT_FILE: fingerprintFile,
      REGISTRATION_ENABLED: "true",
      SUPABASE_AUTH_URL: authUrl,
      SUPABASE_AUTH_PUBLISHABLE_KEY: authKey,
      SUPABASE_AUTH_SERVICE_ROLE_KEY: "sb_secret_test_key_12345678901234567890",
      NEXT_PUBLIC_SUPABASE_AUTH_URL: authUrl,
      NEXT_PUBLIC_SUPABASE_AUTH_PUBLISHABLE_KEY: authKey,
      ...overrides,
    },
  });
}

test("web entrypoint accepts the exact Supabase project baked into the build", () => {
  const result = runEntrypoint();
  assert.equal(result.status, 0, result.stderr);
});

test("web entrypoint rejects server/browser Supabase drift", () => {
  const result = runEntrypoint({
    SUPABASE_AUTH_URL: "https://different.supabase.co",
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /server\/browser URLs do not match/);
});

test("web entrypoint rejects runtime credentials not baked into the client", () => {
  const replacement = "sb_publishable_replacement_key_123456789012345";
  const result = runEntrypoint({
    SUPABASE_AUTH_PUBLISHABLE_KEY: replacement,
    NEXT_PUBLIC_SUPABASE_AUTH_PUBLISHABLE_KEY: replacement,
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /build\/runtime projects do not match/);
});
