import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

const script = new URL(
  "../deploy/droplet/validate-database-config.sh",
  import.meta.url,
).pathname;
const target = "aws-1-ap-northeast-2.pooler.supabase.com:5432/postgres";

function url(role, projectRef = "projectref", targetOverride = target) {
  return `postgresql://${role}.${projectRef}:encoded-password@${targetOverride}?sslmode=require`;
}

function run(overrides = {}) {
  return spawnSync("/bin/sh", [script], {
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      ...overrides,
    },
  });
}

function validExternal() {
  return {
    DATABASE_MODE: "external",
    ADMIN_DATABASE_URL: url("postgres"),
    WEB_DATABASE_URL: url("agentify_web"),
    WORKER_DATABASE_URL: url("agentify_worker"),
    PRIVACY_DATABASE_URL: url("agentify_privacy"),
    DASHBOARD_DATABASE_URL: url("agentify_dashboard"),
  };
}

function privateUrl(role, database = "agentify_scanner") {
  return `postgresql://${role}:private-password@agentify-scanner-postgres:5432/${database}`;
}

function validPrivate() {
  return {
    DATABASE_MODE: "private",
    ADMIN_DATABASE_URL: privateUrl("coinslot"),
    WEB_DATABASE_URL: privateUrl("agentify_web"),
    WORKER_DATABASE_URL: privateUrl("agentify_worker"),
    PRIVACY_DATABASE_URL: privateUrl("agentify_privacy"),
    DASHBOARD_DATABASE_URL: privateUrl("agentify_dashboard"),
  };
}

test("local database mode rejects external overrides", () => {
  assert.equal(run({ DATABASE_MODE: "local" }).status, 0);
  const invalid = run({
    DATABASE_MODE: "local",
    ADMIN_DATABASE_URL: url("postgres"),
  });
  assert.notEqual(invalid.status, 0);
});

test("external database mode accepts five matching session-pooler URLs", () => {
  const result = run(validExternal());
  assert.equal(result.status, 0, result.stderr);
});

test("admin-only tooling validates without receiving runtime credentials", () => {
  const result = run({
    DATABASE_MODE: "external",
    DATABASE_CONFIG_SCOPE: "admin",
    ADMIN_DATABASE_URL: url("postgres"),
  });
  assert.equal(result.status, 0, result.stderr);
});

test("external database mode rejects partial and split-brain configuration", () => {
  const partial = validExternal();
  delete partial.WORKER_DATABASE_URL;
  assert.notEqual(run(partial).status, 0);

  const splitBrain = validExternal();
  splitBrain.PRIVACY_DATABASE_URL = url(
    "agentify_privacy",
    "otherprojectref",
    "aws-1-us-east-1.pooler.supabase.com:5432/postgres",
  );
  assert.notEqual(run(splitBrain).status, 0);
});

test("external database mode rejects transaction pooler and wrong role identity", () => {
  const transactionPooler = validExternal();
  transactionPooler.ADMIN_DATABASE_URL = url(
    "postgres",
    "projectref",
    "aws-1-ap-northeast-2.pooler.supabase.com:6543/postgres",
  );
  assert.notEqual(run(transactionPooler).status, 0);

  const wrongRole = validExternal();
  wrongRole.WEB_DATABASE_URL = url("postgres");
  assert.notEqual(run(wrongRole).status, 0);
});

test("validation failures never echo credentials", () => {
  const secret = "never-print-this-secret";
  const invalid = validExternal();
  invalid.ADMIN_DATABASE_URL = `postgresql://postgres.projectref:${secret}@aws-1-ap-northeast-2.pooler.supabase.com:6543/postgres?sslmode=require`;
  const result = run(invalid);
  assert.notEqual(result.status, 0);
  assert.equal(`${result.stdout}${result.stderr}`.includes(secret), false);
});

test("private scanner mode accepts only its separate database and least-privilege roles", () => {
  assert.equal(run(validPrivate()).status, 0);
  const wrongDatabase = validPrivate();
  wrongDatabase.WORKER_DATABASE_URL = privateUrl("agentify_worker", "coinslot");
  assert.notEqual(run(wrongDatabase).status, 0);
  const wrongAdmin = validPrivate();
  wrongAdmin.ADMIN_DATABASE_URL = privateUrl("postgres");
  assert.notEqual(run(wrongAdmin).status, 0);
  const splitHost = validPrivate();
  splitHost.PRIVACY_DATABASE_URL = "postgresql://agentify_privacy:secret@other-postgres:5432/agentify_scanner";
  assert.notEqual(run(splitHost).status, 0);
  const missingRole = validPrivate();
  delete missingRole.DASHBOARD_DATABASE_URL;
  assert.notEqual(run(missingRole).status, 0);
});

test("private admin scope needs no runtime secrets and never prints a password", () => {
  const accepted = run({
    DATABASE_MODE: "private",
    DATABASE_CONFIG_SCOPE: "admin",
    ADMIN_DATABASE_URL: privateUrl("coinslot"),
  });
  assert.equal(accepted.status, 0, accepted.stderr);
  const rejected = run({
    DATABASE_MODE: "private",
    ADMIN_DATABASE_URL: "postgresql://coinslot:do-not-print@agentify-scanner-postgres:5432/coinslot",
  });
  assert.notEqual(rejected.status, 0);
  assert.equal(`${rejected.stdout}${rejected.stderr}`.includes("do-not-print"), false);
});
