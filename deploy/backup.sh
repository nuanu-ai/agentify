#!/usr/bin/env bash
# Takes one snapshot of this host's channel into its restic repository.
# agentify-backup.timer runs it every ten minutes as agentify-backup.service,
# and deploy/install.sh installs it as /usr/local/sbin/agentify-backup:
#
#   sudo agentify-backup
#
# A snapshot holds a pg_dump of every database of the channel, the database
# server's roles, the row count of every table as its dump holds it, the
# channel's environment file and release.json. It never holds
# /etc/agentify/backup.env, which holds the repository's password and the S3
# key: whoever has the snapshots must not find in them the key to all of them.
#
# The databases are the server's own list rather than names written here:
# every database but the server's `postgres`, the templates, the test suites'
# `*_test`, and the scratch a restore or a check leaves behind (`*_restoring`,
# `*_replaced_*`, `check_*`). So the list follows the planned merge into one
# database without a change here.
#
# The dumps are taken under the release lock, which releases, restores and the
# nightly privacy job take too, so no dump is of a half-migrated database. The
# lock is waited for five minutes at most; a lock still busy then is exit 75
# with nothing dumped, and the next run, ten minutes on, tries again. The lock
# is released before the upload, so a slow bucket never holds a release back.
# The dumps are not compressed (-Z0), which lets restic find what did not
# change and compress the rest. Every run forgets old snapshots, keeping every
# one of the last 144, one an hour for 48 hours and one a day for 30 days, and
# the first run of each day prunes the data nothing refers to any more.
#
# A success is a line in the journal and a line in
# /var/lib/agentify/<channel>/backup-status, which anyone on the host can read.
# A failure is one sentence naming its step and a non-zero exit, which
# agentify-backup-failed.service records in the journal.
set -Eeuo pipefail
umask 077

step="checking" stored="nothing was stored, and the next run tries again"
refuse() { echo "backup: $*" >&2; exit 1; }
failed() {
  local code=$?
  ((BASH_SUBSHELL == 0)) || exit "$code"
  echo "backup: $step failed; $stored." >&2
  exit "$code"
}
trap failed ERR
trap 'echo "backup: $step was interrupted; $stored." >&2; exit 143' INT TERM HUP

# Replaces one line of the status file, which anyone on the host may read.
record() {
  local file="$state/backup-status"
  (
    flock 8
    { grep -v "^$1 " "$file" 2>/dev/null || true; echo "$1 $2"; } | sort > "$file.new"
    chmod 644 "$file.new"
    mv "$file.new" "$file"
  ) 8> /run/lock/agentify-backup-status.lock
}

[[ $EUID -eq 0 ]] || refuse "a backup reads root's files; run it as root."
channel="$(python3 -c 'import json; print(json.load(open("/etc/agentify/release.json"))["channel"])')" \
  || refuse "/etc/agentify/release.json does not name this host's channel; deploy/install.sh writes it."
secrets=/etc/agentify/backup.env
[[ -f $secrets ]] \
  || refuse "$secrets does not exist, so there is no repository to back up into; deploy/README.md, \"Backups\", says how to write it."
[[ $(stat -c '%U %a' "$secrets") == "root 600" ]] || refuse "$secrets opens every snapshot, so it belongs to root with mode 600."
set -a
# shellcheck source=/dev/null
. "$secrets"
set +a
state="/var/lib/agentify/$channel"

# The database is found the way a release finds it, by the Compose labels of
# the channel's project, through the stack.sh of a checkout that ran a release.
# Every such checkout describes the same project, and current's is tried
# first; a checkout without images.env never ran one.
current="$(cat "$state/current" 2> /dev/null || true)" stack=""
for checkout in ${current:+"$state/checkouts/$current"} "$state"/checkouts/*; do
  if [[ -f $checkout/deploy/images.env ]]; then
    stack="$checkout/deploy/stack.sh"
    break
  fi
done
[[ -n $stack ]] || refuse "no checkout under $state/checkouts ran a release, so this host runs no database to back up."
work="$(mktemp -d /var/tmp/agentify-backup.XXXXXX)"
trap 'rm -rf "$work"' EXIT

step="waiting for the release lock"
exec 9> /run/lock/agentify-release.lock
flock -w 300 9 || {
  echo "backup: a release, a restore or the privacy job held the release lock for five minutes, so nothing was dumped; the next run tries again." >&2
  exit 75
}
step="finding the database"
postgres="$("$stack" "$channel" ps -q postgres)"
[[ -n $postgres ]] || refuse "the channel's postgres service is not running, so there is nothing to dump; $stored."
[[ $postgres != *$'\n'* ]] || refuse "the channel runs more than one postgres container, and a backup does not choose between them; $stored."
sql() { docker exec -i "$postgres" psql -U agentify_commerce -d postgres -XAtq -v ON_ERROR_STOP=1; }

step="listing the databases"
listed="$(sql <<< "SELECT datname FROM pg_database WHERE NOT datistemplate ORDER BY datname")"
databases=()
for database in $listed; do
  if [[ $database =~ ^(postgres$|check_)|_replaced_|_restoring$|_test$ ]]; then continue; fi
  [[ $database =~ ^[a-z_][a-z0-9_]*$ ]] || refuse "the server holds a database named $database, which this script does not name safely; $stored."
  databases+=("$database")
done
((${#databases[@]})) || refuse "the server holds no database of the channel, only $(tr '\n' ' ' <<< "$listed"); $stored."
for database in "${databases[@]}"; do
  step="dumping $database"
  docker exec "$postgres" pg_dump -U agentify_commerce -Fc -Z0 "$database" > "$work/$database.dump"
done
step="dumping the roles"
docker exec "$postgres" pg_dumpall -U agentify_commerce --roles-only > "$work/roles.sql"
exec 9>&-

step="copying the configuration"
install -m 600 "/etc/agentify/$channel.env" /etc/agentify/release.json "$work/"
# The row counts a check compares a restore with: the lines of each table's
# COPY block, which pg_restore renders from the dump itself.
for database in "${databases[@]}"; do
  step="counting the rows in the dump of $database"
  docker exec -i "$postgres" pg_restore -f - < "$work/$database.dump" | awk -v database="$database" '
    copying && $0 == "\\." { print database, table, rows; copying = 0; next }
    copying { rows++; next }
    /^COPY / { table = substr($0, 6); sub(/ (\(.*\) )?FROM stdin;$/, "", table); sub(/ +$/, "", table); rows = 0; copying = 1 }' \
    >> "$work/counts"
done

step="uploading the snapshot"
cd "$work"
summary="$(restic backup --retry-lock 5m --json --quiet --tag "$channel" -- ./*.dump roles.sql counts "$channel.env" release.json)"
step="reading the snapshot's ID"
snapshot="$(sed -n 's/.*"snapshot_id":"\([0-9a-f]*\)".*/\1/p' <<< "$summary")"
[[ -n $snapshot ]]
stored="snapshot ${snapshot:0:8} is stored"
record backup "$(date -u +%FT%TZ) snapshot ${snapshot:0:8} of ${databases[*]}"

# One policy over every snapshot in the repository. restic groups by host and
# paths unless told otherwise, and each snapshot's paths name its own
# temporary directory, so by default every snapshot is a group of one and
# nothing is ever forgotten.
step="forgetting old snapshots"
restic forget --retry-lock 5m --quiet --group-by '' --keep-last 144 --keep-hourly 48 --keep-daily 30
if [[ $(sed -n 's/^prune \([0-9-]*\)T.*/\1/p' "$state/backup-status" 2> /dev/null || true) != "$(date -u +%F)" ]]; then
  step="pruning the data of forgotten snapshots"
  restic prune --retry-lock 5m --quiet
  record prune "$(date -u +%FT%TZ)"
fi
echo "backup: snapshot ${snapshot:0:8} holds ${databases[*]}, the roles, $channel.env and release.json."
