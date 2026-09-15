#!/usr/bin/env sh
set -eu

mode="${DATABASE_MODE:-local}"
scope="${DATABASE_CONFIG_SCOPE:-all}"

fail() {
  echo "Database configuration is invalid: $1" >&2
  exit 1
}

case "$scope" in
  all | admin) ;;
  *) fail "DATABASE_CONFIG_SCOPE must be all or admin" ;;
esac

validate_supabase_url() {
  expected_role="$1"
  value="$2"

  case "$value" in
    postgresql://*) ;;
    *) fail "$expected_role URL must use postgresql://" ;;
  esac

  remainder="${value#postgresql://}"
  credentials="${remainder%%@*}"
  target_and_query="${remainder#*@}"
  [ "$target_and_query" != "$remainder" ] || fail "$expected_role URL has no host"
  case "$target_and_query" in
    *@*) fail "$expected_role URL contains an unencoded @ character" ;;
  esac

  username="${credentials%%:*}"
  password="${credentials#*:}"
  [ "$password" != "$credentials" ] && [ -n "$password" ] || \
    fail "$expected_role URL has no password"

  case "$username" in
    "$expected_role".*) ;;
    *) fail "$expected_role URL must use the $expected_role.<project-ref> pooler username" ;;
  esac
  project_ref="${username#*.}"
  [ -n "$project_ref" ] || fail "$expected_role URL has no project ref"

  target="${target_and_query%%\?*}"
  hostport="${target%%/*}"
  database="${target#*/}"
  [ "$database" != "$target" ] || fail "$expected_role URL has no database"
  [ "$database" = "postgres" ] || fail "$expected_role URL must use the postgres database"
  case "$hostport" in
    *.pooler.supabase.com:5432) ;;
    *) fail "$expected_role URL must use the Supabase session pooler on port 5432" ;;
  esac

  [ "$target_and_query" != "$target" ] || fail "$expected_role URL must require TLS"
  query="${target_and_query#*\?}"
  case "&$query&" in
    *"&sslmode=require&"*) ;;
    *) fail "$expected_role URL must include sslmode=require" ;;
  esac

  VALIDATED_TARGET="$target"
  VALIDATED_PROJECT_REF="$project_ref"
}

validate_private_url() {
  expected_role="$1"
  value="$2"
  case "$value" in
    postgresql://*) ;;
    *) fail "$expected_role URL must use postgresql://" ;;
  esac
  remainder="${value#postgresql://}"
  credentials="${remainder%%@*}"
  target="${remainder#*@}"
  [ "$target" != "$remainder" ] || fail "$expected_role URL has no host"
  case "$target" in *@*) fail "$expected_role URL contains an unencoded @ character" ;; esac
  username="${credentials%%:*}"
  password="${credentials#*:}"
  [ "$username" = "$expected_role" ] && [ "$password" != "$credentials" ] && [ -n "$password" ] || \
    fail "$expected_role URL has the wrong role or no password"
  [ "$target" = 'agentify-scanner-postgres:5432/agentify_scanner' ] || \
    fail "$expected_role URL must target only the private scanner DB alias and database"
}

case "$mode" in
  local)
    [ -z "${ADMIN_DATABASE_URL:-}${WEB_DATABASE_URL:-}${WORKER_DATABASE_URL:-}${PRIVACY_DATABASE_URL:-}${DASHBOARD_DATABASE_URL:-}" ] || \
      fail "external URL overrides are forbidden while DATABASE_MODE=local"
    ;;
  external)
    : "${ADMIN_DATABASE_URL:?ADMIN_DATABASE_URL is required for DATABASE_MODE=external}"
    validate_supabase_url postgres "$ADMIN_DATABASE_URL"
    shared_target="$VALIDATED_TARGET"
    shared_project_ref="$VALIDATED_PROJECT_REF"

    if [ "$scope" = "all" ]; then
      : "${WEB_DATABASE_URL:?WEB_DATABASE_URL is required for DATABASE_MODE=external}"
      : "${WORKER_DATABASE_URL:?WORKER_DATABASE_URL is required for DATABASE_MODE=external}"
      : "${PRIVACY_DATABASE_URL:?PRIVACY_DATABASE_URL is required for DATABASE_MODE=external}"
      : "${DASHBOARD_DATABASE_URL:?DASHBOARD_DATABASE_URL is required for DATABASE_MODE=external}"

      validate_supabase_url agentify_web "$WEB_DATABASE_URL"
      [ "$VALIDATED_TARGET" = "$shared_target" ] || fail "web URL targets a different database"
      [ "$VALIDATED_PROJECT_REF" = "$shared_project_ref" ] || fail "web URL uses a different project ref"

      validate_supabase_url agentify_worker "$WORKER_DATABASE_URL"
      [ "$VALIDATED_TARGET" = "$shared_target" ] || fail "worker URL targets a different database"
      [ "$VALIDATED_PROJECT_REF" = "$shared_project_ref" ] || fail "worker URL uses a different project ref"

      validate_supabase_url agentify_privacy "$PRIVACY_DATABASE_URL"
      [ "$VALIDATED_TARGET" = "$shared_target" ] || fail "privacy URL targets a different database"
      [ "$VALIDATED_PROJECT_REF" = "$shared_project_ref" ] || fail "privacy URL uses a different project ref"

      validate_supabase_url agentify_dashboard "$DASHBOARD_DATABASE_URL"
      [ "$VALIDATED_TARGET" = "$shared_target" ] || fail "dashboard URL targets a different database"
      [ "$VALIDATED_PROJECT_REF" = "$shared_project_ref" ] || fail "dashboard URL uses a different project ref"
    fi
    ;;
  private)
    : "${ADMIN_DATABASE_URL:?ADMIN_DATABASE_URL is required for DATABASE_MODE=private}"
    validate_private_url coinslot "$ADMIN_DATABASE_URL"
    if [ "$scope" = "all" ]; then
      : "${WEB_DATABASE_URL:?WEB_DATABASE_URL is required for DATABASE_MODE=private}"
      : "${WORKER_DATABASE_URL:?WORKER_DATABASE_URL is required for DATABASE_MODE=private}"
      : "${PRIVACY_DATABASE_URL:?PRIVACY_DATABASE_URL is required for DATABASE_MODE=private}"
      : "${DASHBOARD_DATABASE_URL:?DASHBOARD_DATABASE_URL is required for DATABASE_MODE=private}"
      validate_private_url agentify_web "$WEB_DATABASE_URL"
      validate_private_url agentify_worker "$WORKER_DATABASE_URL"
      validate_private_url agentify_privacy "$PRIVACY_DATABASE_URL"
      validate_private_url agentify_dashboard "$DASHBOARD_DATABASE_URL"
    fi
    ;;
  *) fail "DATABASE_MODE must be local, external, or private" ;;
esac

echo "Database configuration validated for $mode mode ($scope scope)."
