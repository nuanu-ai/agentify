#!/usr/bin/env sh
set -eu

: "${POSTGRES_WEB_PASSWORD:?POSTGRES_WEB_PASSWORD is required}"
: "${POSTGRES_WORKER_PASSWORD:?POSTGRES_WORKER_PASSWORD is required}"
: "${POSTGRES_PRIVACY_PASSWORD:?POSTGRES_PRIVACY_PASSWORD is required}"
: "${POSTGRES_DASHBOARD_PASSWORD:?POSTGRES_DASHBOARD_PASSWORD is required}"

reconcile_passwords="${RECONCILE_RUNTIME_ROLE_PASSWORDS:-}"
if [ -z "$reconcile_passwords" ]; then
  if [ -n "${POSTGRES_CONNECTION_URL:-}" ]; then
    reconcile_passwords=false
  else
    reconcile_passwords=true
  fi
fi
case "$reconcile_passwords" in
  true | false) ;;
  *)
    echo "RECONCILE_RUNTIME_ROLE_PASSWORDS must be true or false." >&2
    exit 1
    ;;
esac

run_psql() {
  if [ -n "${POSTGRES_CONNECTION_URL:-}" ]; then
    psql --dbname "$POSTGRES_CONNECTION_URL" "$@"
  elif [ -n "${POSTGRES_HOST:-}" ]; then
    psql --host "$POSTGRES_HOST" --username "$POSTGRES_USER" \
      --dbname "$POSTGRES_DB" "$@"
  else
    psql --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" "$@"
  fi
}

if [ -n "${POSTGRES_CONNECTION_URL:-}" ] && [ "$reconcile_passwords" = "false" ]; then
  existing_runtime_roles="$(run_psql --set=ON_ERROR_STOP=1 -Atc \
    "select count(*) from pg_roles where rolname in ('agentify_web','agentify_worker','agentify_privacy','agentify_dashboard')")"
  if [ "$existing_runtime_roles" != "4" ]; then
    echo "External runtime roles are missing; explicit password reconciliation is required." >&2
    exit 1
  fi
fi

run_psql --set=ON_ERROR_STOP=1 <<'SQL'
REVOKE CREATE ON SCHEMA public FROM PUBLIC;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'agentify_web') THEN
    CREATE ROLE agentify_web LOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'agentify_worker') THEN
    CREATE ROLE agentify_worker LOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'agentify_privacy') THEN
    CREATE ROLE agentify_privacy LOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'agentify_dashboard') THEN
    CREATE ROLE agentify_dashboard LOGIN;
  END IF;
END
$$;
SQL

if [ -n "${POSTGRES_CONNECTION_URL:-}" ]; then
  # Supabase's postgres role has CREATEROLE but is intentionally not a
  # superuser. PostgreSQL only permits a real superuser to include
  # NOSUPERUSER/NOBYPASSRLS in ALTER ROLE, even when the flags are already
  # false. Assert the safe attributes first, then change only login/password.
  run_psql --set=ON_ERROR_STOP=1 <<'SQL'
DO $runtime_role_safety$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_roles
    WHERE rolname IN ('agentify_web', 'agentify_worker', 'agentify_privacy', 'agentify_dashboard')
      AND (NOT rolcanlogin OR rolsuper OR rolcreatedb OR rolcreaterole OR rolbypassrls)
  ) THEN
    RAISE EXCEPTION 'an Agentify runtime role has elevated attributes';
  END IF;
END
$runtime_role_safety$;
SQL

  if [ "$reconcile_passwords" = "true" ]; then
    run_psql --set=ON_ERROR_STOP=1 \
      --set=web_password="$POSTGRES_WEB_PASSWORD" \
      --set=worker_password="$POSTGRES_WORKER_PASSWORD" \
      --set=privacy_password="$POSTGRES_PRIVACY_PASSWORD" \
      --set=dashboard_password="$POSTGRES_DASHBOARD_PASSWORD" <<'SQL'
ALTER ROLE agentify_web WITH LOGIN PASSWORD :'web_password';
ALTER ROLE agentify_worker WITH LOGIN PASSWORD :'worker_password';
ALTER ROLE agentify_privacy WITH LOGIN PASSWORD :'privacy_password';
ALTER ROLE agentify_dashboard WITH LOGIN PASSWORD :'dashboard_password';
SQL
  fi
else
  if [ "$reconcile_passwords" = "true" ]; then
    run_psql --set=ON_ERROR_STOP=1 \
      --set=web_password="$POSTGRES_WEB_PASSWORD" \
      --set=worker_password="$POSTGRES_WORKER_PASSWORD" \
      --set=privacy_password="$POSTGRES_PRIVACY_PASSWORD" \
      --set=dashboard_password="$POSTGRES_DASHBOARD_PASSWORD" <<'SQL'
ALTER ROLE agentify_web WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS PASSWORD :'web_password';
ALTER ROLE agentify_worker WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS PASSWORD :'worker_password';
ALTER ROLE agentify_privacy WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS PASSWORD :'privacy_password';
ALTER ROLE agentify_dashboard WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS PASSWORD :'dashboard_password';
SQL
  fi
fi

if [ "$reconcile_passwords" = "true" ]; then
  run_psql --set=ON_ERROR_STOP=1 <<'SQL'
ALTER ROLE agentify_web SET search_path TO public, pgboss;
ALTER ROLE agentify_worker SET search_path TO public, pgboss;
ALTER ROLE agentify_privacy SET search_path TO public;
ALTER ROLE agentify_dashboard SET search_path TO metabase;
SQL
elif [ -n "${POSTGRES_CONNECTION_URL:-}" ]; then
  run_psql --set=ON_ERROR_STOP=1 <<'SQL'
DO $runtime_role_settings$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_roles
    WHERE rolname = 'agentify_web'
      AND COALESCE(rolconfig, ARRAY[]::text[]) @> ARRAY['search_path=public, pgboss']
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_roles
    WHERE rolname = 'agentify_worker'
      AND COALESCE(rolconfig, ARRAY[]::text[]) @> ARRAY['search_path=public, pgboss']
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_roles
    WHERE rolname = 'agentify_privacy'
      AND COALESCE(rolconfig, ARRAY[]::text[]) @> ARRAY['search_path=public']
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_roles
    WHERE rolname = 'agentify_dashboard'
      AND COALESCE(rolconfig, ARRAY[]::text[]) @> ARRAY['search_path=metabase']
  ) THEN
    RAISE EXCEPTION 'an Agentify runtime role has an unexpected search_path';
  END IF;
END
$runtime_role_settings$;
SQL
fi

run_psql --set=ON_ERROR_STOP=1 <<'SQL'
SELECT format(
  'GRANT CONNECT ON DATABASE %I TO agentify_web, agentify_worker, agentify_privacy, agentify_dashboard',
  current_database()
) \gexec
GRANT USAGE ON SCHEMA public TO agentify_web, agentify_worker, agentify_privacy;
REVOKE ALL ON SCHEMA public FROM agentify_dashboard;
SQL
