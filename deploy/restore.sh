#!/usr/bin/env bash
# Puts both databases of this host's channel back the way a restore point
# holds them:
#
#   sudo deploy/restore.sh /var/backups/agentify/<channel>/<time>-<previous>-before-<new>
#
# deploy/activate.sh runs it itself when a release fails during its
# migrations, and a person runs it the same way, from the checkout the failure
# message names. Everything written to the databases after the dump is lost.
#
# It takes the release lock, and run by hand it waits while a release unit
# runs, so neither a release, TEST's timer nor the nightly privacy job runs
# while it does. Before it changes anything, it marks the channel's transition
# record as restoring, and no release starts until a restore finishes. It
# stops the four applications that write, restores each dump into a scratch
# database, and only when both are whole renames them in, in one transaction,
# dropping the replaced databases after. A bad dump, a failure or a crash
# before that transaction leaves the databases as they were; running it again
# starts over.
#
# Then `current` names the revision whose data the databases hold, the
# restore point's <previous>, so a release of <new> or of anything later
# migrates again, and the transition record goes. The applications stay
# stopped until a release starts them.
set -Eeuo pipefail
dir="${1%/}"
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
previous=""
if [[ ${dir##*/} =~ ^[0-9]{8}T[0-9]{6}Z-([0-9a-f]{40})-before- ]]; then previous="${BASH_REMATCH[1]}"; fi

# deploy/activate.sh hands its lock over on descriptor 9. Run by hand, this
# also waits for a release unit that has not taken the lock yet.
if ! { true >&9; } 2>/dev/null; then
  if systemctl is-active --quiet 'agentify-release*.service' 2>/dev/null; then
    echo "restore: a release is running (systemctl status 'agentify-release*.service'); nothing was changed." >&2
    exit 75
  fi
  exec 9>/run/lock/agentify-release.lock
fi
flock -n 9 || { echo "restore: a release or the privacy job holds the release lock; nothing was changed." >&2; exit 75; }
trap 'echo "restore: $step failed, before the restored databases were swapped in, so the databases are as they were and nothing was started; run this again." >&2' ERR

transition set restore="$dir" restoring="$root/deploy/restore.sh"
step="stopping the applications"
stack stop --timeout 60 gateway cabinet scanner scanner-worker
stack up -d --wait --no-deps postgres
for database in agentify_commerce agentify_scanner; do
  step="restoring $database into ${database}_restoring"
  echo "restore: $step, from $dir" >&2
  sql -c "DROP DATABASE IF EXISTS ${database}_restoring WITH (FORCE)" -c "DROP DATABASE IF EXISTS ${database}_replaced WITH (FORCE)" \
    -c "CREATE DATABASE ${database}_restoring"
  stack exec -T postgres pg_restore -U agentify_commerce -d "${database}_restoring" --exit-on-error < "$dir/$database.dump"
done
step="swapping the restored databases in"
sql >/dev/null <<'SQL'
SELECT pg_terminate_backend(pid) FROM pg_stat_activity
  WHERE datname IN ('agentify_commerce', 'agentify_scanner') AND pid <> pg_backend_pid();
BEGIN;
ALTER DATABASE agentify_commerce RENAME TO agentify_commerce_replaced;
ALTER DATABASE agentify_commerce_restoring RENAME TO agentify_commerce;
ALTER DATABASE agentify_scanner RENAME TO agentify_scanner_replaced;
ALTER DATABASE agentify_scanner_restoring RENAME TO agentify_scanner;
COMMIT;
SQL
trap - ERR
sql -c "DROP DATABASE agentify_commerce_replaced WITH (FORCE)" -c "DROP DATABASE agentify_scanner_replaced WITH (FORCE)" \
  || echo "restore: the replaced databases stay beside the restored ones until the next restore drops them." >&2

if [[ -n $previous ]]; then
  (umask 022 && echo "$previous" > "$state/current.new" && mv "$state/current.new" "$state/current")
else
  rm -f "$state/current"
fi
transition clear
rm -f "$state/cards-before"
echo "restore: agentify_commerce and agentify_scanner hold what $dir holds, and ${previous:-no revision} is current; gateway, cabinet, scanner and scanner-worker are stopped until a release starts them." >&2
