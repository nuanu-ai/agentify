#!/usr/bin/env sh
set -eu

[ "${DATABASE_MODE:-local}" = "external" ] || [ "${DATABASE_MODE:-local}" = "private" ] || {
  echo "Database verification requires DATABASE_MODE=external or private." >&2
  exit 1
}
/runtime-validate-database-config.sh

check_identity() {
  expected="$1"
  url="$2"
  actual="$(psql --dbname "$url" --set=ON_ERROR_STOP=1 -Atc 'select current_user')"
  [ "$actual" = "$expected" ] || {
    echo "Database role identity check failed for $expected." >&2
    exit 1
  }
}

if [ "${DATABASE_MODE:-local}" = "private" ]; then
  check_identity agentify_commerce "$ADMIN_DATABASE_URL"
else
  check_identity postgres "$ADMIN_DATABASE_URL"
fi
check_identity agentify_web "$WEB_DATABASE_URL"
check_identity agentify_worker "$WORKER_DATABASE_URL"
check_identity agentify_privacy "$PRIVACY_DATABASE_URL"
check_identity agentify_dashboard "$DASHBOARD_DATABASE_URL"

psql --dbname "$ADMIN_DATABASE_URL" --set=ON_ERROR_STOP=1 <<'SQL' >/dev/null
DO $database_assertions$
BEGIN
  IF (SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public') < 23 THEN
    RAISE EXCEPTION 'expected Agentify public tables are missing';
  END IF;
  IF (SELECT count(*) FROM information_schema.tables WHERE table_schema = 'pgboss') < 1 THEN
    RAISE EXCEPTION 'pg-boss schema is missing';
  END IF;
  IF to_regclass('drizzle.__drizzle_migrations') IS NULL THEN
    RAISE EXCEPTION 'Drizzle migration journal is missing';
  END IF;
  IF (SELECT count(*) FROM information_schema.views WHERE table_schema = 'metabase') < 15 THEN
    RAISE EXCEPTION 'PII-minimized Metabase views are missing';
  END IF;

  IF has_table_privilege('agentify_worker', 'public.leads', 'SELECT') THEN
    RAISE EXCEPTION 'agentify_worker can read leads';
  END IF;
  IF has_table_privilege('agentify_web', 'public.worker_heartbeats', 'INSERT') THEN
    RAISE EXCEPTION 'agentify_web can write worker heartbeats';
  END IF;
  IF has_table_privilege('agentify_web', 'public.scan_fingerprints', 'UPDATE') THEN
    RAISE EXCEPTION 'agentify_web can update fingerprints';
  END IF;
  IF NOT has_table_privilege('agentify_web', 'public.rate_limit_events', 'SELECT')
     OR NOT has_table_privilege('agentify_web', 'public.rate_limit_events', 'INSERT') THEN
    RAISE EXCEPTION 'agentify_web lacks rolling rate-limit privileges';
  END IF;
  IF NOT has_table_privilege('agentify_web', 'public.registration_intents', 'SELECT,INSERT,UPDATE,DELETE') THEN
    RAISE EXCEPTION 'agentify_web lacks registration intent privileges';
  END IF;
  IF has_table_privilege('agentify_web', 'public.rate_limit_events', 'DELETE') THEN
    RAISE EXCEPTION 'agentify_web can delete rolling rate-limit events';
  END IF;
  IF NOT has_table_privilege('agentify_privacy', 'public.leads', 'SELECT,UPDATE') THEN
    RAISE EXCEPTION 'agentify_privacy lacks cleanup privileges';
  END IF;
  IF has_table_privilege('agentify_dashboard', 'public.leads', 'SELECT')
     OR has_table_privilege('agentify_dashboard', 'public.scans', 'SELECT') THEN
    RAISE EXCEPTION 'agentify_dashboard can read application tables directly';
  END IF;
  IF NOT has_schema_privilege('agentify_dashboard', 'metabase', 'USAGE')
     OR NOT has_table_privilege('agentify_dashboard', 'metabase.operator_overview', 'SELECT')
     OR NOT has_table_privilege('agentify_dashboard', 'metabase.operator_recent_scans', 'SELECT') THEN
    RAISE EXCEPTION 'agentify_dashboard lacks operator view access';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    CROSS JOIN LATERAL aclexplode(COALESCE(
      c.relacl,
      acldefault(CASE WHEN c.relkind = 'S' THEN 'S'::"char" ELSE 'r'::"char" END, c.relowner)
    )) acl
    LEFT JOIN pg_roles grantee ON grantee.oid = acl.grantee
    WHERE n.nspname IN ('public', 'pgboss')
      AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
      AND (acl.grantee = 0 OR grantee.rolname IN ('anon', 'authenticated', 'service_role'))
  ) THEN
    RAISE EXCEPTION 'application relations are exposed to a Supabase API role or PUBLIC';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_default_acl d
    JOIN pg_namespace n ON n.oid = d.defaclnamespace
    CROSS JOIN LATERAL aclexplode(d.defaclacl) acl
    LEFT JOIN pg_roles grantee ON grantee.oid = acl.grantee
    WHERE n.nspname IN ('public', 'pgboss')
      AND d.defaclrole = (SELECT oid FROM pg_roles WHERE rolname = current_user)
      AND (acl.grantee = 0 OR grantee.rolname IN ('anon', 'authenticated', 'service_role'))
  ) THEN
    RAISE EXCEPTION 'application default ACL exposes a Supabase API role or PUBLIC';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relrowsecurity
      AND NOT EXISTS (
        SELECT 1 FROM pg_policy p
        WHERE p.polrelid = c.oid AND p.polname = 'agentify_web_service'
      )
  ) THEN
    RAISE EXCEPTION 'an RLS table lacks the Agentify web policy';
  END IF;
END
$database_assertions$;
SQL

echo "External database connectivity, schema, RLS, and least-privilege checks passed."
