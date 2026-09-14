#!/usr/bin/env sh
set -eu

: "${POSTGRES_HOST:?POSTGRES_HOST is required}"
: "${POSTGRES_DB:?POSTGRES_DB is required}"
: "${POSTGRES_ADMIN_PASSWORD:?POSTGRES_ADMIN_PASSWORD is required}"
: "${POSTGRES_PRIVACY_PASSWORD:?POSTGRES_PRIVACY_PASSWORD is required}"
: "${POSTGRES_DASHBOARD_PASSWORD:?POSTGRES_DASHBOARD_PASSWORD is required}"

validate_script="${VALIDATE_DATABASE_CONFIG_SCRIPT:-/runtime-validate-database-config.sh}"
roles_script="${RUNTIME_ROLES_SCRIPT:-/runtime-roles/10-runtime-roles.sh}"

"$validate_script"

mode="${DATABASE_MODE:-local}"
reconcile_passwords="${RECONCILE_RUNTIME_ROLE_PASSWORDS:-}"
if [ -z "$reconcile_passwords" ]; then
  if [ "$mode" = "external" ]; then
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
export RECONCILE_RUNTIME_ROLE_PASSWORDS="$reconcile_passwords"

if [ "$mode" = "external" ]; then
  export POSTGRES_CONNECTION_URL="$ADMIN_DATABASE_URL"
  export PGCONNECT_TIMEOUT=3

  external_roles_connect() {
    psql "$ADMIN_DATABASE_URL" -Atc "select 1" >/dev/null 2>&1 &&
      psql "$WEB_DATABASE_URL" -Atc "select 1" >/dev/null 2>&1 &&
      psql "$WORKER_DATABASE_URL" -Atc "select 1" >/dev/null 2>&1 &&
      psql "$PRIVACY_DATABASE_URL" -Atc "select 1" >/dev/null 2>&1 &&
      psql "$DASHBOARD_DATABASE_URL" -Atc "select 1" >/dev/null 2>&1
  }

  if [ "$reconcile_passwords" = "false" ]; then
    if ! external_roles_connect; then
      echo "External runtime credentials are unreachable; refusing implicit password rotation." >&2
      exit 1
    fi
    "$roles_script"
    if ! external_roles_connect; then
      echo "External runtime credentials became unreachable during non-rotating reconciliation." >&2
      exit 1
    fi
    exit 0
  fi

  if [ "${ROLE_PASSWORD_ROTATION_MAINTENANCE_ACK:-false}" != "true" ]; then
    echo "Explicit external password rotation requires maintenance acknowledgement." >&2
    exit 1
  fi

  echo "External runtime password rotation requested; application clients must remain stopped."
  "$roles_script"

  wait_attempts="${EXTERNAL_ROLE_WAIT_ATTEMPTS:-8}"
  wait_seconds="${EXTERNAL_ROLE_WAIT_SECONDS:-15}"
  case "$wait_attempts" in
    "" | *[!0-9]* | 0)
      echo "External role wait settings are invalid." >&2
      exit 1
      ;;
  esac
  case "$wait_seconds" in
    "" | *[!0-9]*)
      echo "External role wait settings are invalid." >&2
      exit 1
      ;;
  esac

  sleep 5
  attempt=1
  while [ "$attempt" -le "$wait_attempts" ]; do
    if external_roles_connect; then
      exit 0
    fi
    [ "$attempt" -eq "$wait_attempts" ] || sleep "$wait_seconds"
    attempt=$((attempt + 1))
  done

  echo "External database roles did not become reachable after reconciliation." >&2
  exit 1
fi

can_connect() {
  PGPASSWORD="$2" psql --host "$POSTGRES_HOST" --username "$1" \
    --dbname "$POSTGRES_DB" -Atc "select 1" >/dev/null 2>&1
}

wait_attempts="${LOCAL_DATABASE_WAIT_ATTEMPTS:-30}"
wait_seconds="${LOCAL_DATABASE_WAIT_SECONDS:-2}"
case "$wait_attempts" in
  "" | *[!0-9]* | 0)
    echo "Local database wait settings are invalid." >&2
    exit 1
    ;;
esac
case "$wait_seconds" in
  "" | *[!0-9]*)
    echo "Local database wait settings are invalid." >&2
    exit 1
    ;;
esac

attempt=1
local_owner=""
while [ "$attempt" -le "$wait_attempts" ]; do
  if can_connect agentify_admin "$POSTGRES_ADMIN_PASSWORD"; then
    local_owner="agentify_admin"
    break
  fi
  if [ -n "${LEGACY_POSTGRES_PASSWORD:-}" ] && \
    can_connect agentify "$LEGACY_POSTGRES_PASSWORD"; then
    local_owner="agentify"
    break
  fi
  [ "$attempt" -eq "$wait_attempts" ] || sleep "$wait_seconds"
  attempt=$((attempt + 1))
done

if [ -z "$local_owner" ]; then
  echo "Neither agentify_admin nor the legacy agentify owner became reachable." >&2
  exit 1
fi

if [ "$local_owner" = "agentify" ]; then
  PGPASSWORD="$LEGACY_POSTGRES_PASSWORD" psql --host "$POSTGRES_HOST" \
    --username agentify --dbname "$POSTGRES_DB" --set=ON_ERROR_STOP=1 \
    --set=admin_password="$POSTGRES_ADMIN_PASSWORD" <<'SQL'
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'agentify_admin') THEN
    CREATE ROLE agentify_admin LOGIN SUPERUSER CREATEDB CREATEROLE;
  END IF;
END
$$;
ALTER ROLE agentify_admin WITH LOGIN SUPERUSER CREATEDB CREATEROLE PASSWORD :'admin_password';
SQL
fi

export PGPASSWORD="$POSTGRES_ADMIN_PASSWORD"
export POSTGRES_USER=agentify_admin
exec "$roles_script"
