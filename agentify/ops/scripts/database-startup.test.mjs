import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const compose = readFileSync(
  new URL("../deploy/droplet/compose.production.yaml", import.meta.url),
  "utf8",
);
const caddy = readFileSync(
  new URL("../deploy/droplet/Caddyfile", import.meta.url),
  "utf8",
);
const productionHealthMonitor = readFileSync(
  new URL(
    "../deploy/workflows/production-health-monitor.yml",
    import.meta.url,
  ),
  "utf8",
);
const reconcile = new URL(
  "../deploy/droplet/reconcile-runtime-roles.sh",
  import.meta.url,
).pathname;
const runtimeRoles = new URL(
  "../deploy/droplet/postgres-init/10-runtime-roles.sh",
  import.meta.url,
).pathname;

test("external database startup is not gated by the local postgres service", () => {
  const rolesService = compose.match(
    /  roles-reconcile:\n(?<body>[\s\S]*?)\n  queue-init:/,
  )?.groups?.body;
  assert.ok(rolesService, "roles-reconcile service must exist");
  assert.doesNotMatch(rolesService, /depends_on:[\s\S]*?postgres:/);
});

test("local postgres is opt-in and excluded from external default services", () => {
  const postgresService = compose.match(
    /  postgres:\n(?<body>[\s\S]*?)\n  migrate:/,
  )?.groups?.body;
  assert.ok(postgresService, "postgres service must exist");
  assert.match(postgresService, /^    profiles: \[local\]$/m);
});

test("operator dashboard is protected at the edge and uses a read-only database URL", () => {
  assert.match(caddy, /@admin path \/admin \/admin\/\*/);
  assert.match(caddy, /basic_auth/);
  assert.match(caddy, /X-Robots-Tag "noindex, nofollow"/);
  assert.match(caddy, /Referrer-Policy "no-referrer"/);
  assert.match(compose, /DASHBOARD_DATABASE_URL:/);
  assert.match(compose, /ADMIN_BASIC_AUTH_HASH:/);
});

test("edge access logs are structured, correlated and exclude request secrets", () => {
  assert.match(caddy, /output stdout/);
  assert.match(caddy, /request>remote_ip delete/);
  assert.match(caddy, /request>client_ip delete/);
  assert.match(caddy, /request>uri delete/);
  assert.match(caddy, /request>headers delete/);
  assert.match(caddy, /resp_headers delete/);
  assert.match(caddy, /log_append request_id \{http\.request\.uuid\}/);
  assert.match(caddy, /request_header X-Request-Id \{http\.request\.uuid\}/);
  assert.match(caddy, /header >X-Request-Id \{http\.request\.uuid\}/);
  assert.match(caddy, /default other/);
});

test("production health monitor is fixed, scheduled and incident-deduplicated", () => {
  assert.match(productionHealthMonitor, /cron: "\*\/5 \* \* \* \*"/);
  assert.match(productionHealthMonitor, /mode:/);
  assert.match(productionHealthMonitor, /- test_failure/);
  assert.match(
    productionHealthMonitor,
    /https:\/\/agentify\.ad\/api\/health/,
  );
  assert.match(productionHealthMonitor, /https:\/\/agentify\.ad\/store/);
  assert.match(
    productionHealthMonitor,
    /\[Production\] Agentify health degraded/,
  );
  assert.match(productionHealthMonitor, /state: "open"/);
  assert.match(productionHealthMonitor, /state: "closed"/);
  assert.match(
    productionHealthMonitor,
    /Controlled alert-lifecycle test; production was not intentionally degraded/,
  );
  assert.doesNotMatch(productionHealthMonitor, /inputs:\s*\n\s+url:/);
  assert.doesNotMatch(productionHealthMonitor, /console\.log/);
});

test("local role reconciliation waits for postgres readiness", () => {
  const directory = mkdtempSync(join(tmpdir(), "agentify-db-wait-"));
  const attempts = join(directory, "attempts");
  const psql = join(directory, "psql");
  const validate = join(directory, "validate.sh");
  const roles = join(directory, "roles.sh");

  writeFileSync(
    psql,
    `#!/bin/sh\ncount=$(cat "${attempts}" 2>/dev/null || echo 0)\ncount=$((count + 1))\necho "$count" > "${attempts}"\n[ "$count" -ge 2 ]\n`,
  );
  writeFileSync(validate, "#!/bin/sh\nexit 0\n");
  writeFileSync(roles, "#!/bin/sh\nexit 0\n");
  chmodSync(psql, 0o700);
  chmodSync(validate, 0o700);
  chmodSync(roles, 0o700);

  const result = spawnSync("/bin/sh", [reconcile], {
    encoding: "utf8",
    env: {
      PATH: `${directory}:${process.env.PATH}`,
      POSTGRES_HOST: "postgres",
      POSTGRES_DB: "agentify",
      POSTGRES_ADMIN_PASSWORD: "admin-secret",
      POSTGRES_PRIVACY_PASSWORD: "privacy-secret",
      POSTGRES_DASHBOARD_PASSWORD: "dashboard-secret",
      DATABASE_MODE: "local",
      LOCAL_DATABASE_WAIT_ATTEMPTS: "3",
      LOCAL_DATABASE_WAIT_SECONDS: "0",
      VALIDATE_DATABASE_CONFIG_SCRIPT: validate,
      RUNTIME_ROLES_SCRIPT: roles,
    },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(attempts, "utf8").trim(), "2");
});

test("local role reconciliation rejects malformed wait settings", () => {
  const result = spawnSync("/bin/sh", [reconcile], {
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      POSTGRES_HOST: "postgres",
      POSTGRES_DB: "agentify",
      POSTGRES_ADMIN_PASSWORD: "admin-secret",
      POSTGRES_PRIVACY_PASSWORD: "privacy-secret",
      POSTGRES_DASHBOARD_PASSWORD: "dashboard-secret",
      DATABASE_MODE: "local",
      LOCAL_DATABASE_WAIT_ATTEMPTS: "1:",
      LOCAL_DATABASE_WAIT_SECONDS: "2:3",
      VALIDATE_DATABASE_CONFIG_SCRIPT: "/usr/bin/true",
      RUNTIME_ROLES_SCRIPT: "/usr/bin/true",
    },
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /wait settings are invalid/);
});

test("external role reconciliation waits for pooler credential propagation", () => {
  const directory = mkdtempSync(join(tmpdir(), "agentify-role-wait-"));
  const attempts = join(directory, "attempts");
  const reconciled = join(directory, "reconciled");
  const connectTimeout = join(directory, "connect-timeout");
  const psql = join(directory, "psql");
  const roles = join(directory, "roles.sh");

  writeFileSync(
    psql,
    `#!/bin/sh\necho "$PGCONNECT_TIMEOUT" > "${connectTimeout}"\ncount=$(cat "${attempts}" 2>/dev/null || echo 0)\ncount=$((count + 1))\necho "$count" > "${attempts}"\n[ "$count" -ge 3 ]\n`,
  );
  writeFileSync(roles, `#!/bin/sh\ntouch "${reconciled}"\n`);
  chmodSync(psql, 0o700);
  chmodSync(roles, 0o700);

  const result = spawnSync("/bin/sh", [reconcile], {
    encoding: "utf8",
    env: {
      PATH: `${directory}:${process.env.PATH}`,
      POSTGRES_HOST: "postgres",
      POSTGRES_DB: "agentify",
      POSTGRES_ADMIN_PASSWORD: "admin-secret",
      POSTGRES_PRIVACY_PASSWORD: "privacy-secret",
      POSTGRES_DASHBOARD_PASSWORD: "dashboard-secret",
      DATABASE_MODE: "external",
      RECONCILE_RUNTIME_ROLE_PASSWORDS: "true",
      ROLE_PASSWORD_ROTATION_MAINTENANCE_ACK: "true",
      ADMIN_DATABASE_URL: "postgresql://admin",
      WEB_DATABASE_URL: "postgresql://web",
      WORKER_DATABASE_URL: "postgresql://worker",
      PRIVACY_DATABASE_URL: "postgresql://privacy",
      DASHBOARD_DATABASE_URL: "postgresql://dashboard",
      EXTERNAL_ROLE_WAIT_ATTEMPTS: "4",
      EXTERNAL_ROLE_WAIT_SECONDS: "0",
      VALIDATE_DATABASE_CONFIG_SCRIPT: "/usr/bin/true",
      RUNTIME_ROLES_SCRIPT: roles,
    },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(attempts, "utf8").trim(), "7");
  assert.equal(readFileSync(reconciled, "utf8"), "");
  assert.equal(readFileSync(connectTimeout, "utf8").trim(), "3");
});

test("external role reconciliation rejects malformed wait settings", () => {
  const result = spawnSync("/bin/sh", [reconcile], {
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      POSTGRES_HOST: "postgres",
      POSTGRES_DB: "agentify",
      POSTGRES_ADMIN_PASSWORD: "admin-secret",
      POSTGRES_PRIVACY_PASSWORD: "privacy-secret",
      POSTGRES_DASHBOARD_PASSWORD: "dashboard-secret",
      DATABASE_MODE: "external",
      RECONCILE_RUNTIME_ROLE_PASSWORDS: "true",
      ROLE_PASSWORD_ROTATION_MAINTENANCE_ACK: "true",
      ADMIN_DATABASE_URL: "postgresql://admin",
      WEB_DATABASE_URL: "postgresql://web",
      WORKER_DATABASE_URL: "postgresql://worker",
      PRIVACY_DATABASE_URL: "postgresql://privacy",
      DASHBOARD_DATABASE_URL: "postgresql://dashboard",
      EXTERNAL_ROLE_WAIT_ATTEMPTS: "1:2",
      EXTERNAL_ROLE_WAIT_SECONDS: "",
      VALIDATE_DATABASE_CONFIG_SCRIPT: "/usr/bin/true",
      RUNTIME_ROLES_SCRIPT: "/usr/bin/true",
    },
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /wait settings are invalid/);
});

test("external reconciliation defaults to a non-rotating credential preflight", () => {
  const directory = mkdtempSync(join(tmpdir(), "agentify-role-preflight-"));
  const calls = join(directory, "calls");
  const mode = join(directory, "mode");
  const psql = join(directory, "psql");
  const roles = join(directory, "roles.sh");
  writeFileSync(psql, `#!/bin/sh\necho call >> "${calls}"\nexit 0\n`);
  writeFileSync(
    roles,
    `#!/bin/sh\necho "$RECONCILE_RUNTIME_ROLE_PASSWORDS" > "${mode}"\n`,
  );
  chmodSync(psql, 0o700);
  chmodSync(roles, 0o700);

  const result = spawnSync("/bin/sh", [reconcile], {
    encoding: "utf8",
    env: {
      PATH: `${directory}:${process.env.PATH}`,
      POSTGRES_HOST: "postgres",
      POSTGRES_DB: "agentify",
      POSTGRES_ADMIN_PASSWORD: "admin-secret",
      POSTGRES_PRIVACY_PASSWORD: "privacy-secret",
      POSTGRES_DASHBOARD_PASSWORD: "dashboard-secret",
      DATABASE_MODE: "external",
      ADMIN_DATABASE_URL: "postgresql://admin",
      WEB_DATABASE_URL: "postgresql://web",
      WORKER_DATABASE_URL: "postgresql://worker",
      PRIVACY_DATABASE_URL: "postgresql://privacy",
      DASHBOARD_DATABASE_URL: "postgresql://dashboard",
      VALIDATE_DATABASE_CONFIG_SCRIPT: "/usr/bin/true",
      RUNTIME_ROLES_SCRIPT: roles,
    },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(mode, "utf8").trim(), "false");
  assert.equal(readFileSync(calls, "utf8").trim().split("\n").length, 10);
});

test("external password rotation fails closed without maintenance acknowledgement", () => {
  const result = spawnSync("/bin/sh", [reconcile], {
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      POSTGRES_HOST: "postgres",
      POSTGRES_DB: "agentify",
      POSTGRES_ADMIN_PASSWORD: "admin-secret",
      POSTGRES_PRIVACY_PASSWORD: "privacy-secret",
      POSTGRES_DASHBOARD_PASSWORD: "dashboard-secret",
      DATABASE_MODE: "external",
      RECONCILE_RUNTIME_ROLE_PASSWORDS: "true",
      ADMIN_DATABASE_URL: "postgresql://admin",
      WEB_DATABASE_URL: "postgresql://web",
      WORKER_DATABASE_URL: "postgresql://worker",
      PRIVACY_DATABASE_URL: "postgresql://privacy",
      DASHBOARD_DATABASE_URL: "postgresql://dashboard",
      VALIDATE_DATABASE_CONFIG_SCRIPT: "/usr/bin/true",
      RUNTIME_ROLES_SCRIPT: "/usr/bin/true",
    },
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /maintenance acknowledgement/);
});

function captureRuntimeRoleSql(reconcilePasswords) {
  const directory = mkdtempSync(join(tmpdir(), "agentify-role-sql-"));
  const capture = join(directory, "captured.sql");
  const psql = join(directory, "psql");
  writeFileSync(
    psql,
    `#!/bin/sh\ncase "$*" in *"select count"*) echo 4; exit 0;; esac\ncat >> "$CAPTURE_SQL"\n`,
  );
  chmodSync(psql, 0o700);
  const env = {
    PATH: `${directory}:${process.env.PATH}`,
    CAPTURE_SQL: capture,
    POSTGRES_CONNECTION_URL: "postgresql://admin",
    POSTGRES_WEB_PASSWORD: "web-secret",
    POSTGRES_WORKER_PASSWORD: "worker-secret",
    POSTGRES_PRIVACY_PASSWORD: "privacy-secret",
    POSTGRES_DASHBOARD_PASSWORD: "dashboard-secret",
  };
  if (reconcilePasswords !== undefined) {
    env.RECONCILE_RUNTIME_ROLE_PASSWORDS = reconcilePasswords;
  }
  const result = spawnSync("/bin/sh", [runtimeRoles], {
    encoding: "utf8",
    env,
  });
  assert.equal(result.status, 0, result.stderr);
  return readFileSync(capture, "utf8");
}

test("normal external reconciliation emits no runtime ALTER ROLE statements", () => {
  const sql = captureRuntimeRoleSql();
  assert.doesNotMatch(sql, /ALTER ROLE agentify_/);
  assert.match(sql, /runtime_role_safety/);
  assert.match(sql, /runtime_role_settings/);
});

test("explicit external rotation owns password and search_path mutations", () => {
  const sql = captureRuntimeRoleSql("true");
  assert.match(sql, /ALTER ROLE agentify_web WITH LOGIN PASSWORD/);
  assert.match(sql, /ALTER ROLE agentify_web SET search_path/);
});
