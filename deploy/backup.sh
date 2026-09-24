#!/usr/bin/env bash
# One snapshot of PRODUCTION into its restic repository, every ten minutes from
# agentify-backup.timer (deploy/README.md, "Backups"). A snapshot holds a
# pg_dump of every database on the server except postgres, the test suites'
# *_test and the scratch that restores and checks leave, so the list survives the
# merge into one database. It also holds the server's roles, the row count of each
# table as its dump holds it, production.env and release.json. It never holds
# backup.env, which opens the snapshots. The dumps are taken under the
# release lock, waited for five minutes at most (then exit 75 with nothing
# dumped); the upload runs after the lock is released.
set -Eeuo pipefail
umask 077
trap 'echo "backup: line $LINENO failed: $BASH_COMMAND" >&2' ERR
# shellcheck source=/dev/null
set -a && . /etc/agentify/backup.env && set +a
state=/var/lib/agentify/production work="$(mktemp -d /var/tmp/agentify-backup.XXXXXX)"
trap 'rm -rf "$work"' EXIT
exec 9> /run/lock/agentify-release.lock
flock -w 300 9 || { echo "backup: the release lock stayed busy for five minutes; nothing was dumped." >&2; exit 75; }
# Found by Compose's labels, as a release finds it; deploy/stack.sh names the project.
postgres="$(docker ps -q --filter label=com.docker.compose.project=agentify-commerce --filter label=com.docker.compose.service=postgres)"
(($(wc -w <<< "$postgres") == 1)) || { echo "backup: PRODUCTION's postgres container is not running, so nothing was dumped." >&2; exit 1; }
databases=()
for database in $(docker exec "$postgres" psql -U agentify_commerce -d postgres -XAtc "SELECT datname FROM pg_database WHERE NOT datistemplate"); do
  [[ $database =~ ^(postgres$|check_)|_replaced_|_restoring$|_test$ ]] || databases+=("$database")
done
for database in "${databases[@]}"; do
  docker exec "$postgres" pg_dump -U agentify_commerce -Fc -Z0 "$database" > "$work/$database.dump"
done
docker exec "$postgres" pg_dumpall -U agentify_commerce --roles-only > "$work/roles.sql"
exec 9>&-
install -m 600 /etc/agentify/production.env /etc/agentify/release.json "$work/"
for database in "${databases[@]}"; do # the lines of each COPY block, which the restore rehearsal compares with
  docker exec -i "$postgres" pg_restore -f - < "$work/$database.dump" | awk -v db="$database" '
    copying && $0 == "\\." { print db "|" table "|" rows; copying = 0 } copying { rows++ }
    /^COPY / { table = substr($0, 6); sub(/ (\(.*\) )?FROM stdin;$/, "", table); rows = 0; copying = 1 }' >> "$work/counts"
done
cd "$work"
snapshot="$(restic backup --retry-lock 5m --json --quiet --tag production -- ./*.dump roles.sql counts production.env release.json)"
snapshot="$(sed -n 's/.*"snapshot_id":"\([0-9a-f]\{8\}\).*/\1/p' <<< "$snapshot")"
# One group: restic groups by host and paths by default, and every snapshot's
# paths name its own temporary directory, so nothing would ever be forgotten.
restic forget --retry-lock 5m --quiet --group-by '' --keep-last 144 --keep-hourly 48 --keep-daily 30
if [[ $(cat "$state/backup-pruned" 2> /dev/null) != "$(date -u +%F)" ]]; then
  restic prune --retry-lock 5m --quiet
  date -u +%F > "$state/backup-pruned"
fi
{ echo "backup $(date -u +%FT%TZ) snapshot $snapshot of ${databases[*]}"; grep '^check ' "$state/backup-status" 2> /dev/null || true; } > "$state/backup-status.new"
chmod 644 "$state/backup-status.new"
mv "$state/backup-status.new" "$state/backup-status"
echo "backup: snapshot $snapshot holds ${databases[*]}."
