#!/usr/bin/env bash
# Proves once a week that the latest snapshot restores whole.
# agentify-backup-check.timer runs it as agentify-backup-check.service, and
# deploy/install.sh installs it as /usr/local/sbin/agentify-backup-check:
#
#   sudo agentify-backup-check
#
# It runs restic's own check of the repository, restores the latest snapshot,
# loads each of its dumps into a scratch database named check_<database> on the
# channel's own server, and compares every table's row count with the count
# the snapshot recorded when it was taken. It compares with that record rather
# than with the live databases, which move on, and it never touches them.
# Before it restores anything it checks that the database volume has room for
# a second copy of the databases and a GiB more, as a restore does. The
# scratch databases are dropped however the check ends, and so are any that a
# check stopped halfway left behind.
#
# The result, passed or failed, is a line in
# /var/lib/agentify/<channel>/backup-status, which anyone on the host can read.
# A failure is also one sentence naming its step and a non-zero exit, which
# agentify-backup-failed.service records in the journal.
set -Eeuo pipefail
umask 077

step="checking" failure="" passed="" state="" postgres="" work=""
refuse() { failure="$*"; echo "backup-check: $*" >&2; exit 1; }
failed() {
  local code=$?
  ((BASH_SUBSHELL == 0)) || exit "$code"
  failure="$step failed"
  echo "backup-check: $failure; the live databases were not touched." >&2
  exit "$code"
}
trap failed ERR
trap 'failure="$step was interrupted"; exit 143' INT TERM HUP

# Replaces one line of the status file, which anyone on the host may read.
record() {
  local file="$state/backup-status"
  (
    flock 8
    { grep -v "^$1 " "$file" 2> /dev/null || true; echo "$1 $2"; } | sort > "$file.new"
    chmod 644 "$file.new"
    mv "$file.new" "$file"
  ) 8> /run/lock/agentify-backup-status.lock
}
sql() { docker exec -i "$postgres" psql -U agentify_commerce -d "${1:-postgres}" -XAtq -v ON_ERROR_STOP=1; }
drop_scratch() {
  local listed database
  listed="$(sql <<< "SELECT datname FROM pg_database WHERE NOT datistemplate ORDER BY datname")" || return 1
  for database in $listed; do
    if [[ $database == check_* ]]; then sql <<< "DROP DATABASE IF EXISTS $database WITH (FORCE);" || return 1; fi
  done
}
finish() {
  local code=$?
  trap - ERR
  set +e
  if [[ -n $postgres ]] && ! drop_scratch; then
    echo "backup-check: the scratch databases could not all be dropped; drop every check_* database by hand." >&2
  fi
  [[ -z $work ]] || rm -rf "$work"
  if [[ -n $state ]]; then
    if ((code == 0)); then
      record check "$(date -u +%FT%TZ) passed: $passed"
    else
      record check "$(date -u +%FT%TZ) failed: ${failure:-$step failed}"
    fi
  fi
}
trap finish EXIT

[[ $EUID -eq 0 ]] || refuse "the check reads root's files; run it as root."
channel="$(python3 -c 'import json; print(json.load(open("/etc/agentify/release.json"))["channel"])')" \
  || refuse "/etc/agentify/release.json does not name this host's channel; deploy/install.sh writes it."
state="/var/lib/agentify/$channel"
secrets=/etc/agentify/backup.env
[[ -f $secrets ]] \
  || refuse "$secrets does not exist, so there is no repository to check; deploy/README.md, \"Backups\", says how to write it."
[[ $(stat -c '%U %a' "$secrets") == "root 600" ]] || refuse "$secrets opens every snapshot, so it belongs to root with mode 600."
set -a
# shellcheck source=/dev/null
. "$secrets"
set +a

# The database is found as deploy/backup.sh finds it.
current="$(cat "$state/current" 2> /dev/null || true)" stack=""
for checkout in ${current:+"$state/checkouts/$current"} "$state"/checkouts/*; do
  if [[ -f $checkout/deploy/images.env ]]; then
    stack="$checkout/deploy/stack.sh"
    break
  fi
done
[[ -n $stack ]] || refuse "no checkout under $state/checkouts ran a release, so this host runs no database to restore into."
step="finding the database"
found="$("$stack" "$channel" ps -q postgres)"
[[ -n $found && $found != *$'\n'* ]] || refuse "the channel does not run exactly one postgres container, so there is nowhere to restore into."
postgres="$found"
step="dropping the scratch databases an earlier check left"
drop_scratch

step="checking the repository"
restic check --retry-lock 5m --quiet
step="finding the latest snapshot"
snapshot="$(restic snapshots --retry-lock 5m --json latest | python3 -c 'import json, sys; print("".join(s["id"] for s in json.load(sys.stdin)[-1:]))')"
[[ -n $snapshot ]] || refuse "the repository holds no snapshot, so there is nothing to check."
step="restoring snapshot ${snapshot:0:8}"
work="$(mktemp -d /var/tmp/agentify-backup-check.XXXXXX)"
restic restore "$snapshot" --retry-lock 5m --quiet --target "$work"
[[ -f $work/counts ]] \
  || refuse "snapshot ${snapshot:0:8} recorded no row counts, so its restore has nothing to be compared with; only a snapshot deploy/backup.sh took has them."
databases=()
for dump in "$work"/*.dump; do
  if [[ -f $dump ]]; then databases+=("$(basename "$dump" .dump)"); fi
done
((${#databases[@]})) || refuse "snapshot ${snapshot:0:8} holds no dump."
while read -r database _; do
  [[ -f $work/$database.dump ]] || refuse "snapshot ${snapshot:0:8} recorded row counts of $database and holds no dump of it."
done < "$work/counts"

step="measuring the room on the database volume"
quoted="$(printf "'%s'," "${databases[@]}")"
size="$(sql <<< "SELECT coalesce(sum(pg_database_size(datname)), 0) FROM pg_database WHERE datname IN (${quoted%,})")"
# Whole numbers, multiplied here: an awk may print a large product as 1.02e+12,
# which bash arithmetic cannot read.
free="$(docker exec "$postgres" df -Pk /var/lib/postgresql/data | awk 'NR == 2 { print $4 }')"
[[ $free =~ ^[0-9]+$ && $size =~ ^[0-9]+$ ]] || refuse "the room on the database volume could not be measured, so nothing was restored."
free=$((free * 1024))
((free > size + (1 << 30))) \
  || refuse "the database volume has $((free >> 20)) MiB free, and a scratch copy of $((size >> 20)) MiB of databases needs that and a GiB more; nothing was restored."

tables=0 rows=0
for database in "${databases[@]}"; do
  step="restoring $database into check_$database"
  sql <<< "CREATE DATABASE check_$database;"
  docker exec -i "$postgres" pg_restore -U agentify_commerce -d "check_$database" --exit-on-error < "$work/$database.dump"
  step="counting the rows of check_$database"
  query="" names=() expected=() n=0
  while read -r owner table count; do
    if [[ $owner != "$database" ]]; then continue; fi
    n=$((n + 1)) names[n]=$table expected[n]=$count
    query+="${query:+ UNION ALL }SELECT $n, count(*) FROM $table"
  done < "$work/counts"
  ((n)) || continue
  counted="$(sql "check_$database" <<< "$query ORDER BY 1;")"
  while IFS='|' read -r i count; do
    [[ $count == "${expected[i]}" ]] \
      || refuse "check_$database's ${names[i]} holds $count rows where snapshot ${snapshot:0:8} recorded ${expected[i]}, so the snapshot does not restore whole."
    rows=$((rows + count))
  done <<< "$counted"
  tables=$((tables + n))
done
passed="snapshot ${snapshot:0:8} restored whole, ${#databases[@]} database(s), $tables tables and $rows rows, every count as the snapshot recorded it"
echo "backup-check: $passed."
