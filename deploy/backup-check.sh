#!/usr/bin/env bash
# A restore rehearsal, which a person starts (agentify-backup-check.service,
# deploy/README.md "Backups"); nothing schedules it: restic's own check of the
# repository, then the latest snapshot restored into scratch databases
# check_<database> on PRODUCTION's server. Every table must hold the row count
# that the snapshot recorded when it was taken. The check compares with that
# record, not with the live databases, which move on and which it never
# touches. The scratch databases are dropped however it ends, and the result
# is a line in backup-status.
set -Eeuo pipefail
umask 077
trap 'echo "backup-check: line $LINENO failed: $BASH_COMMAND" >&2' ERR
# shellcheck source=/dev/null
set -a && . /etc/agentify/backup.env && set +a
state=/var/lib/agentify/production work="" result=failed
postgres="$(docker ps -q --filter label=com.docker.compose.project=agentify --filter label=com.docker.compose.service=postgres)"
sql() { docker exec -i "$postgres" psql -U agentify -XAtq -v ON_ERROR_STOP=1 "$@"; }
drop() {
  for database in $(sql -d postgres -c "SELECT datname FROM pg_database WHERE datname LIKE 'check\_%'"); do
    sql -d postgres -c "DROP DATABASE $database WITH (FORCE)"
  done
}
finish() {
  if [[ -n $work ]]; then
    drop || echo "backup-check: drop the check_* databases by hand." >&2
    rm -rf "$work"
  fi
  { grep '^backup ' "$state/backup-status" 2> /dev/null || true; echo "check $(date -u +%FT%TZ) $result"; } > "$state/backup-status.new"
  chmod 644 "$state/backup-status.new"
  mv "$state/backup-status.new" "$state/backup-status"
}
trap finish EXIT
trap 'exit 143' INT TERM HUP
(($(wc -w <<< "$postgres") == 1)) || { echo "backup-check: PRODUCTION's postgres container is not running, so nothing was restored." >&2; exit 1; }
work="$(mktemp -d /var/tmp/agentify-backup-check.XXXXXX)"
drop
restic check --retry-lock 5m --quiet
snapshot="$(restic snapshots --retry-lock 5m --json latest | sed -n 's/.*"short_id":"\([0-9a-f]*\)".*/\1/p')"
restic restore "$snapshot" --retry-lock 5m --quiet --target "$work"
# Every ordinary table and its row count, named as pg_dump names it, in one query.
count="SELECT format('%I.%I', n.nspname, c.relname), (xpath('/row/c/text()', query_to_xml(format('SELECT count(*) AS c FROM %I.%I', n.nspname, c.relname), false, true, '')))[1] FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.relkind = 'r' AND n.nspname NOT IN ('pg_catalog', 'information_schema')"
for dump in "$work"/*.dump; do
  database="$(basename "$dump" .dump)"
  sql -d postgres -c "CREATE DATABASE check_$database"
  docker exec -i "$postgres" pg_restore -U agentify -d "check_$database" --exit-on-error < "$dump"
  sql -d "check_$database" -c "$count" | sed "s/^/$database|/" >> "$work/restored"
done
diff <(sort "$work/counts") <(sort "$work/restored") >&2
result="passed: snapshot $snapshot restored, and its $(wc -l < "$work/counts") tables hold the rows it recorded"
echo "backup-check: $result."
