#!/usr/bin/env bash
# Puts both databases of this host's channel back the way a restore point
# holds them. Only a person restores, through the release command, which runs
# this in the same systemd unit a release runs in, so a dropped connection
# does not stop it halfway:
#
#   sudo agentify-release --restore /var/backups/agentify/<channel>/<time>-<previous>-before-<new>
#
# Everything written to the databases after the dump is lost.
#
# It takes the release lock, so neither a release, TEST's timer nor the nightly
# privacy job runs while it does, and it checks that the database volume has
# room for a second copy of both databases before it changes anything. Then it
# marks the channel's transition record as restoring, which holds every release
# back, stops the four applications that write, restores each dump into a
# scratch database, and only when both are whole renames them in, in one
# transaction. The databases they replace stay, renamed
# <name>_replaced_<time>, until the next verified release drops them. A bad
# dump or a failure before that transaction leaves the databases as they were
# and the record as it found it; a crash leaves the record marked, and running
# this again starts over.
#
# Then `current` names the revision whose data the databases hold, the
# restore point's <previous>, or none for a directory named after no revision,
# so a release of <new> or of anything later migrates again, and the record
# goes. The applications stay stopped until a release starts them.
set -Eeuo pipefail
dir="${1%/}" step="checking"
refuse() { echo "restore: $*" >&2; exit 1; }
[[ $EUID -eq 0 ]] || refuse "restoring runs as root."
[[ -f $dir/agentify_commerce.dump && -f $dir/agentify_scanner.dump ]] \
  || refuse "${dir:-the restore point} holds no dump of agentify_commerce and agentify_scanner."
channel="$(python3 -c 'import json; print(json.load(open("/etc/agentify/release.json"))["channel"])')"
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
state="/var/lib/agentify/$channel"
stack() { "$root/deploy/stack.sh" "$channel" "$@"; }
sql() { stack exec -T postgres psql -U agentify_commerce -d postgres -v ON_ERROR_STOP=1 -q "$@"; }
transition() { "$root/deploy/transition" "$state/transition" "$@"; }
named() { local tags; tags="$(transition tags "$1")"; echo "$1${tags:+ ($tags)}"; }
previous=""
if [[ ${dir##*/} =~ ^[0-9]{8}T[0-9]{6}Z-([0-9a-f]{40})-before- ]]; then previous="${BASH_REMATCH[1]}"; fi

open="$(transition show)" \
  || refuse "$state/transition cannot be read; deploy/README.md, \"The transition record\", says how to move it aside."
IFS='|' read -r _ found found_point _ _ found_restoring _ _ <<<"$open"
exec 9>/run/lock/agentify-release.lock
flock -n 9 || { echo "restore: a release, the privacy job or a process an earlier run left holds the release lock; nothing was changed." >&2; exit 75; }
stack up -d --wait --no-deps postgres
size="$(sql -Atc "select coalesce(sum(pg_database_size(datname)), 0) from pg_database where datname in ('agentify_commerce', 'agentify_scanner')")"
free="$(stack exec -T postgres df -Pk /var/lib/postgresql/data | awk 'NR == 2 { print $4 * 1024 }')"
((free > size + (1 << 30))) \
  || refuse "the database volume has $((free >> 20)) MiB free, and a second copy of $((size >> 20)) MiB of databases needs that and a GiB more; nothing was changed."

# A failure before the swap changed no database, so the record goes back to
# what it was and holds no release back, unless an earlier restore did not
# finish either.
failed() {
  if [[ -n $found_restoring ]]; then
    :
  elif [[ -n $found ]]; then
    transition set restore="$found_point" restoring=
  else
    transition clear
  fi
  echo "restore: $step failed before the restored databases were swapped in, so the databases are as they were. gateway, cabinet, scanner and scanner-worker are stopped, and the channel is down. If the cause has passed, run this again; if the dump itself is bad, restore another restore point, or release again the revision the databases hold." >&2
}
trap failed ERR
transition set restore="$dir" restoring=true
step="stopping the applications"
stack stop --timeout 60 gateway cabinet scanner scanner-worker
for database in agentify_commerce agentify_scanner; do
  step="restoring $database into ${database}_restoring"
  echo "restore: $step, from $dir" >&2
  sql -c "DROP DATABASE IF EXISTS ${database}_restoring WITH (FORCE)" -c "CREATE DATABASE ${database}_restoring"
  stack exec -T postgres pg_restore -U agentify_commerce -d "${database}_restoring" --exit-on-error < "$dir/$database.dump"
done
step="swapping the restored databases in"
stamp="$(date -u +%Y%m%d%H%M%S)"
sql >/dev/null <<SQL
SELECT pg_terminate_backend(pid) FROM pg_stat_activity
  WHERE datname IN ('agentify_commerce', 'agentify_scanner') AND pid <> pg_backend_pid();
BEGIN;
ALTER DATABASE agentify_commerce RENAME TO agentify_commerce_replaced_$stamp;
ALTER DATABASE agentify_commerce_restoring RENAME TO agentify_commerce;
ALTER DATABASE agentify_scanner RENAME TO agentify_scanner_replaced_$stamp;
ALTER DATABASE agentify_scanner_restoring RENAME TO agentify_scanner;
COMMIT;
SQL
trap - ERR

transition finish "$previous"
rm -f "$state/cards-before"
echo "restore: agentify_commerce and agentify_scanner hold what $dir holds, and ${previous:+$(named "$previous") is current}${previous:-no revision is current}. The databases they replaced stay as agentify_commerce_replaced_$stamp and agentify_scanner_replaced_$stamp until a release is verified. gateway, cabinet, scanner and scanner-worker are stopped, and the channel is down until a release starts them." >&2
