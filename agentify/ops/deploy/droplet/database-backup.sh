#!/usr/bin/env sh
set -eu

: "${DATABASE_URL:?DATABASE_URL is required}"

/runtime-validate-database-config.sh

umask 077
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
target="/backups/agentify-$stamp.dump"
temporary="$target.tmp"
cleanup() { rm -f "$temporary"; }
trap cleanup EXIT HUP INT TERM

pg_dump --dbname "$DATABASE_URL" \
  --format=custom \
  --no-owner \
  --no-acl \
  --no-subscriptions \
  --schema=public \
  --schema=pgboss \
  --schema=drizzle \
  --schema=metabase \
  --file="$temporary"
pg_restore --list "$temporary" >/dev/null
mv "$temporary" "$target"
find /backups -type f -name 'agentify-*.dump' -mtime +7 -delete

echo "Application-schema backup created: $(basename "$target")."
