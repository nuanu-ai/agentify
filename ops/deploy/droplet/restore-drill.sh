#!/usr/bin/env bash
set -euo pipefail

BACKUP_DIR="/opt/agentify/shared/backups"
DUMP="${1:-$(find "$BACKUP_DIR" -type f -name 'agentify-*.dump' -print | sort | tail -1)}"
DRILL_CONTAINER="agentify-restore-drill-$(date -u +%Y%m%d%H%M%S)"
DRILL_PASSWORD="$(openssl rand -hex 24)"

test -n "$DUMP"
test -s "$DUMP"
cleanup() { docker rm -f "$DRILL_CONTAINER" >/dev/null 2>&1 || true; }
trap cleanup EXIT

docker run --detach --name "$DRILL_CONTAINER" --network none \
  --env POSTGRES_PASSWORD="$DRILL_PASSWORD" postgres:17.6-alpine >/dev/null
for _ in $(seq 1 30); do
  if docker exec "$DRILL_CONTAINER" pg_isready -U postgres -d postgres >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
docker exec "$DRILL_CONTAINER" pg_isready -U postgres -d postgres >/dev/null
docker exec "$DRILL_CONTAINER" createdb -U postgres agentify_restore
docker exec "$DRILL_CONTAINER" psql -U postgres -d agentify_restore -v ON_ERROR_STOP=1 -c \
  "drop schema public cascade; create role agentify_web nologin; create role agentify_worker nologin; create role agentify_privacy nologin; create role agentify_dashboard nologin;"
docker exec -i "$DRILL_CONTAINER" pg_restore \
  -U postgres -d agentify_restore --exit-on-error --no-owner --no-acl <"$DUMP"

public_tables="$(
  docker exec "$DRILL_CONTAINER" psql -U postgres -d agentify_restore -Atc \
    "select count(*) from information_schema.tables where table_schema = 'public'"
)"
pgboss_tables="$(
  docker exec "$DRILL_CONTAINER" psql -U postgres -d agentify_restore -Atc \
    "select count(*) from information_schema.tables where table_schema = 'pgboss'"
)"
rubric_column="$(
  docker exec "$DRILL_CONTAINER" psql -U postgres -d agentify_restore -Atc \
    "select count(*) from information_schema.columns where table_schema='public' and table_name='scans' and column_name='rubric_version'"
)"
test "$public_tables" -ge 18
test "$pgboss_tables" -ge 1
test "$rubric_column" -eq 1
printf 'Isolated restore drill passed: public=%s, pgboss=%s, dump=%s.\n' \
  "$public_tables" "$pgboss_tables" "$DUMP"
