#!/usr/bin/env sh
set -eu

: "${DATABASE_URL:?DATABASE_URL is required}"

/runtime-validate-database-config.sh

psql --dbname "$DATABASE_URL" --set=ON_ERROR_STOP=1 <<'SQL'
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA pgboss REVOKE ALL ON TABLES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA pgboss REVOKE ALL ON SEQUENCES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA pgboss REVOKE ALL ON FUNCTIONS FROM PUBLIC;

SELECT format('REVOKE ALL PRIVILEGES ON TABLE %I.%I FROM PUBLIC', n.nspname, c.relname)
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname IN ('public', 'pgboss')
  AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
  AND c.relowner = (SELECT oid FROM pg_roles WHERE rolname = current_user)
\gexec

SELECT format('REVOKE ALL PRIVILEGES ON SEQUENCE %I.%I FROM PUBLIC', n.nspname, c.relname)
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname IN ('public', 'pgboss')
  AND c.relkind = 'S'
  AND c.relowner = (SELECT oid FROM pg_roles WHERE rolname = current_user)
\gexec

SELECT format(
  'REVOKE ALL PRIVILEGES ON FUNCTION %I.%I(%s) FROM PUBLIC',
  n.nspname,
  p.proname,
  pg_get_function_identity_arguments(p.oid)
)
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname IN ('public', 'pgboss')
  AND p.proowner = (SELECT oid FROM pg_roles WHERE rolname = current_user)
\gexec

SELECT format(
  'ALTER DEFAULT PRIVILEGES IN SCHEMA %I REVOKE ALL ON TABLES FROM %I',
  schema_name,
  rolname
)
FROM pg_roles
 CROSS JOIN (VALUES ('public'), ('pgboss')) AS schemas(schema_name)
WHERE rolname IN ('anon', 'authenticated', 'service_role')
\gexec
SELECT format(
  'ALTER DEFAULT PRIVILEGES IN SCHEMA %I REVOKE ALL ON SEQUENCES FROM %I',
  schema_name,
  rolname
)
FROM pg_roles
 CROSS JOIN (VALUES ('public'), ('pgboss')) AS schemas(schema_name)
WHERE rolname IN ('anon', 'authenticated', 'service_role')
\gexec
SELECT format(
  'ALTER DEFAULT PRIVILEGES IN SCHEMA %I REVOKE ALL ON FUNCTIONS FROM %I',
  schema_name,
  rolname
)
FROM pg_roles
 CROSS JOIN (VALUES ('public'), ('pgboss')) AS schemas(schema_name)
WHERE rolname IN ('anon', 'authenticated', 'service_role')
\gexec

SELECT format(
  'REVOKE ALL PRIVILEGES ON TABLE %I.%I FROM %I',
  n.nspname,
  c.relname,
  r.rolname
)
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
CROSS JOIN pg_roles r
WHERE n.nspname IN ('public', 'pgboss')
  AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
  AND c.relowner = (SELECT oid FROM pg_roles WHERE rolname = current_user)
  AND r.rolname IN ('anon', 'authenticated', 'service_role')
\gexec

SELECT format(
  'REVOKE ALL PRIVILEGES ON SEQUENCE %I.%I FROM %I',
  n.nspname,
  c.relname,
  r.rolname
)
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
CROSS JOIN pg_roles r
WHERE n.nspname IN ('public', 'pgboss')
  AND c.relkind = 'S'
  AND c.relowner = (SELECT oid FROM pg_roles WHERE rolname = current_user)
  AND r.rolname IN ('anon', 'authenticated', 'service_role')
\gexec

SELECT format(
  'REVOKE ALL PRIVILEGES ON FUNCTION %I.%I(%s) FROM %I',
  n.nspname,
  p.proname,
  pg_get_function_identity_arguments(p.oid),
  r.rolname
)
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
CROSS JOIN pg_roles r
WHERE n.nspname IN ('public', 'pgboss')
  AND p.proowner = (SELECT oid FROM pg_roles WHERE rolname = current_user)
  AND r.rolname IN ('anon', 'authenticated', 'service_role')
\gexec

DO $security_assertions$
DECLARE
  role_row record;
BEGIN
  FOR role_row IN
    SELECT rolname, rolsuper, rolcreatedb, rolcreaterole, rolbypassrls
    FROM pg_roles
    WHERE rolname IN ('agentify_web', 'agentify_worker', 'agentify_privacy', 'agentify_dashboard')
  LOOP
    IF role_row.rolsuper OR role_row.rolcreatedb OR role_row.rolcreaterole OR role_row.rolbypassrls THEN
      RAISE EXCEPTION 'runtime role % has elevated attributes', role_row.rolname;
    END IF;
  END LOOP;

  IF (SELECT count(*) FROM pg_roles WHERE rolname IN (
    'agentify_web', 'agentify_worker', 'agentify_privacy', 'agentify_dashboard'
  )) <> 4 THEN
    RAISE EXCEPTION 'one or more Agentify runtime roles are missing';
  END IF;

  IF has_table_privilege('agentify_worker', 'public.leads', 'SELECT') THEN
    RAISE EXCEPTION 'agentify_worker must not read leads';
  END IF;
  IF has_table_privilege('agentify_web', 'public.worker_heartbeats', 'INSERT') THEN
    RAISE EXCEPTION 'agentify_web must not write worker heartbeats';
  END IF;
  IF NOT has_table_privilege('agentify_privacy', 'public.leads', 'SELECT,UPDATE') THEN
    RAISE EXCEPTION 'agentify_privacy lacks cleanup privileges';
  END IF;
  IF has_table_privilege('agentify_dashboard', 'public.leads', 'SELECT')
     OR has_table_privilege('agentify_dashboard', 'public.scans', 'SELECT') THEN
    RAISE EXCEPTION 'agentify_dashboard must not read application tables directly';
  END IF;
  IF NOT has_schema_privilege('agentify_dashboard', 'metabase', 'USAGE')
     OR NOT has_table_privilege('agentify_dashboard', 'metabase.operator_overview', 'SELECT') THEN
    RAISE EXCEPTION 'agentify_dashboard lacks read-only operator view access';
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
    RAISE EXCEPTION 'application relations expose privileges to a Supabase API role or PUBLIC';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) acl
    LEFT JOIN pg_roles grantee ON grantee.oid = acl.grantee
    WHERE n.nspname IN ('public', 'pgboss')
      AND p.proowner = (SELECT oid FROM pg_roles WHERE rolname = current_user)
      AND (acl.grantee = 0 OR grantee.rolname IN ('anon', 'authenticated', 'service_role'))
  ) THEN
    RAISE EXCEPTION 'application functions expose privileges to a Supabase API role or PUBLIC';
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
    RAISE EXCEPTION 'application default privileges expose a Supabase API role or PUBLIC';
  END IF;
END
$security_assertions$;
SQL

echo "Database ACL hardening and runtime-role assertions passed."
