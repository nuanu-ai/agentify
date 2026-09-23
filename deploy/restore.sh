#!/usr/bin/env bash
# Puts both databases of this host's channel back the way a restore point
# holds them:
#
#   sudo deploy/restore.sh /var/backups/agentify/<channel>/<time>-<previous>-before-<new>
#
# deploy/activate.sh runs it itself when a release fails between its first
# migration and the start of the new release, and a person runs it the same
# way. Everything written to the databases after the dump is lost.
#
# It takes the release lock, so neither a release, TEST's timer nor the nightly
# privacy job runs while it does, and stops the four applications that write.
# Then, for each database, it drops the database with every connection closed
# and creates it again from its dump, stopping at the first error. The
# applications stay stopped. If it fails, the databases may be half restored;
# running it again starts both over.
set -Eeuo pipefail
dir="${1%/}"
refuse() { echo "restore: $*" >&2; exit 1; }
[[ $EUID -eq 0 ]] || refuse "restoring runs as root."
[[ -f $dir/agentify_commerce.dump && -f $dir/agentify_scanner.dump ]] \
  || refuse "${dir:-the restore point} holds no dump of agentify_commerce and agentify_scanner."
channel="$(python3 -c 'import json; print(json.load(open("/etc/agentify/release.json"))["channel"])')"
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
stack() { "$root/deploy/stack.sh" "$channel" "$@"; }

# deploy/activate.sh hands its own lock over on descriptor 9; run by hand,
# this takes it.
if ! { true >&9; } 2>/dev/null; then exec 9>/run/lock/agentify-release.lock; fi
flock -n 9 || { echo "restore: a release or the privacy job holds the release lock; nothing was changed." >&2; exit 75; }
trap 'echo "restore: restoring $database failed, so the databases may be half restored and nothing was started; run this again." >&2' ERR

database="the applications"
stack stop --timeout 60 gateway cabinet scanner scanner-worker
stack up -d --wait --no-deps postgres
for database in agentify_commerce agentify_scanner; do
  echo "restore: $database from $dir" >&2
  stack exec -T postgres psql -U agentify_commerce -d postgres -v ON_ERROR_STOP=1 -q \
    -c "DROP DATABASE IF EXISTS $database WITH (FORCE)"
  stack exec -T postgres pg_restore -U agentify_commerce -d postgres --create --exit-on-error < "$dir/$database.dump"
done

# The release this restore point was taken for is undone, so it no longer
# waits to be finished. The two paths are compared as one directory, however
# each is spelled.
pending="/var/lib/agentify/$channel/pending"
[[ ! $dir -ef $(cut -d' ' -f3 "$pending" 2>/dev/null) ]] || rm -f "$pending"
echo "restore: agentify_commerce and agentify_scanner hold what $dir holds; gateway, cabinet, scanner and scanner-worker are stopped." >&2
