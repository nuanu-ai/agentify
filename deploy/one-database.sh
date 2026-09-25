#!/usr/bin/env bash
# One-time (deploy/README.md, "One database"): moves this host's channel from
# two databases, agentify_commerce and agentify_scanner, in the Compose project
# the host was created under, to one database, agentify, in the project the
# revision's deploy/stack.sh names. A person runs it as root, in one window,
# from the checkout of the revision that expects one database, after
# agentify-release has pulled that revision and been refused for want of the
# new volume:
#
#   sudo /var/lib/agentify/<channel>/checkouts/<revision>/deploy/one-database.sh test|production
#
# Holding the release lock, it stops the scanner's web application and waits
# up to three minutes for the scanner's queue to finish its jobs; when they do
# not finish, it starts the scanner again and refuses. Then it stops the rest,
# takes a restore point of both databases beside the fingerprint of every
# table, stops the old project's database and copies its database and Caddy
# volumes into the new project's. The old containers and volumes are stopped,
# never written again and never removed, so starting them is the fastest way
# back. On the copy, deploy/one-database-move.sh moves the scanner's tables
# into agentify_commerce; the fingerprints of the result must equal the old
# ones, or it stops there. Only then does it compare the metabase views with
# the file they were installed from, drop the scanner's database and the four
# old roles, rename the database and its account to agentify, and give the
# account the password the new configuration names. The applications stay
# stopped until `agentify-release` of the same revision starts them under the
# new project, which takes its own restore point first.
#
# Its progress is one line in /var/lib/agentify/<channel>/one-database, so a
# run that failed or was killed carries on from where the last one got. It
# prints what it does and never a secret.
set -Eeuo pipefail
umask 077

channel="${1:-}"
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
state="/var/lib/agentify/$channel" backups="/var/backups/agentify/$channel"
progress="$state/one-database" move="$root/deploy/one-database-move.sh" step=checking
say() { echo "one-database: $*" >&2; }
refuse() { echo "one-database: $*" >&2; exit 1; }
trap 'echo "one-database: $step failed, for the reason above; running this again carries on from there. The way back: $back" >&2' ERR
back="nothing was stopped."
case "$channel" in test | production) ;; *) refuse "usage: deploy/one-database.sh test|production" ;; esac
[[ $EUID -eq 0 ]] || refuse "it runs as root."
exec 9> /run/lock/agentify-release.lock
flock -n 9 || { say "a release, a restore, a backup or the privacy job holds the release lock; nothing was changed."; exit 75; }

new() { "$root/deploy/stack.sh" "$channel" "$@"; }
[[ -r $root/deploy/images.env ]] \
  || refuse "$root has no images.env: run  sudo agentify-release <this revision>  first, which pulls its images and is refused until this script has run."
current="$(cat "$state/current")"
old() { "$state/checkouts/$current/deploy/stack.sh" "$channel" "$@"; }
project() { "$1" config --no-interpolate | sed -n '1s/^name: //p'; }
volume() { "$1" config --format json | python3 -c 'import json, sys; print(json.load(sys.stdin)["volumes"][sys.argv[1]]["name"])' "$2"; }
old_project="$(project old)" new_project="$(project new)"
[[ $old_project != "$new_project" ]] || refuse "the revision $current and this one both name the project $new_project; there is nothing to move."
old_postgres="$(volume old agentify-postgres)" old_caddy="$(volume old agentify-caddy)"
new_postgres="$(volume new agentify-postgres)" new_caddy="$(volume new agentify-caddy)"
phase="" point="" stopped_at=""
[[ ! -f $progress ]] || read -r phase point stopped_at < "$progress"
image="$(new config --images postgres)"
# Going back also removes what the move made, so that no later release starts
# the new project on a copy beside the old one; writes the new release took go
# with it (deploy/README.md, "One database").
containers="$root/deploy/stack.sh $channel down; docker volume rm -f $new_postgres $new_caddy; rm -f $progress; docker start \$(docker ps -aq --filter label=com.docker.compose.project=$old_project)"
old_sql() { old exec -T postgres psql -X -U agentify_commerce -At "$@"; }

# A person who went back started the old project again, and its data has
# moved on since; this run does not carry on from there.
if [[ -n $phase && -n $(old ps --status running -q gateway) ]]; then
  refuse "the project $old_project runs again after an earlier run reached $phase; to start over, run  $root/deploy/stack.sh $channel down  and  docker volume rm $new_postgres $new_caddy  and remove $progress."
fi
if [[ $phase == "done" ]]; then
  say "$channel already holds one database in the project $new_project; releasing the revision starts it."
  exit 0
fi

if [[ -z $phase ]]; then
  step="checking the host"
  for name in "$new_postgres" "$new_caddy"; do
    ! docker volume inspect "$name" > /dev/null 2>&1 \
      || refuse "the volume $name exists, and this script did not make it; nothing was stopped."
  done
  [[ -n $(old ps --status running -q postgres) ]] || refuse "the database of the project $old_project is not running; nothing was stopped."
  [[ $(old_sql -d postgres -c "select count(*) from pg_database where datname in ('agentify_commerce', 'agentify_scanner')") == 2 ]] \
    || refuse "the project $old_project does not hold agentify_commerce and agentify_scanner; nothing was stopped."
  mkdir -p "$backups"
  databases="$(old_sql -d postgres -c "select sum(pg_database_size(datname)) from pg_database")"
  free="$(df -B1 --output=avail "$backups" | tail -n 1)"
  ((free > databases + (1 << 30))) \
    || refuse "$backups has $((free >> 20)) MiB free, and a restore point of $((databases >> 20)) MiB of databases needs that and a GiB more; nothing was stopped."
  # The volumes live where Docker keeps them, which only a container sees.
  read -r used free < <(docker run --rm --network none -v "$old_postgres:/v:ro" "$image" \
    sh -c 'du -sk /v | cut -f1; df -Pk /v | awk "NR == 2 { print \$4 }"' | paste -sd ' ' -)
  ((free > used + (1 << 20))) \
    || refuse "Docker's disk has $((free >> 10)) MiB free, and a copy of the $((used >> 10)) MiB database volume needs that and a GiB more; nothing was stopped."

  step="waiting for the scanner's queue"
  say "stopping the scanner, so it accepts no new scan, and waiting for its queue to finish"
  stopped_at="$(date +%s)"
  old stop --timeout 60 scanner
  back="$containers"
  unfinished=1
  for _ in {1..90}; do
    unfinished="$(old_sql -d agentify_scanner -c "select count(*) from pgboss.job where state in ('created', 'retry', 'active')")"
    ((unfinished == 0)) && break
    sleep 2
  done
  if ((unfinished > 0)); then
    # By its container, as activate.sh restarts what it stopped: `compose start`
    # walks the dependencies and refuses a one-off migration that is gone.
    old ps -aq scanner | xargs -r docker start > /dev/null
    refuse "the scanner's queue still held $unfinished unfinished jobs after three minutes, so the scanner runs again and nothing else was stopped; run this again later."
  fi

  step="taking the restore point"
  say "stopping gateway, cabinet, scanner-worker and web"
  old stop --timeout 60 gateway cabinet scanner-worker web
  point="$backups/$(date -u +%Y%m%dT%H%M%SZ)-$current-before-one-database"
  say "taking the restore point $point"
  mkdir -p "$point.partial"
  for database in agentify_commerce agentify_scanner; do
    old exec -T postgres pg_dump -U agentify_commerce -Fc "$database" > "$point.partial/$database.dump"
    old exec -T postgres pg_restore --list < "$point.partial/$database.dump" > /dev/null
    old exec -T postgres sh -s -- fingerprints "$database" < "$move" > "$point.partial/$database.fingerprints"
  done
  sync "$point.partial"/*
  mv "$point.partial" "$point"
  echo "stopped $point $stopped_at" > "$progress"
  phase=stopped
fi

if [[ $phase == stopped ]]; then
  step="copying the volumes"
  back="$containers"
  old stop --timeout 60 postgres
  for pair in "$old_postgres $new_postgres" "$old_caddy $new_caddy"; do
    read -r from to <<< "$pair"
    say "copying the volume $from into $to"
    # Phase `stopped` means a copy of this script's own may have been cut short.
    docker volume rm "$to" > /dev/null 2>&1 || true
    docker volume create "$to" > /dev/null
    docker run --rm --network none -v "$from:/from:ro" -v "$to:/to" "$image" cp -a /from/. /to/
  done
  echo "copied $point $stopped_at" > "$progress"
  phase=copied
fi

step="moving the scanner's tables"
back="$containers"
new up -d --wait --no-deps postgres
new exec -T postgres sh -s -- move < "$move"
if [[ -n $(new exec -T postgres psql -X -U agentify_commerce -d postgres -Atc "select 1 from pg_database where datname = 'agentify_scanner'" 2> /dev/null) ]]; then
  step="comparing every table with the restore point's fingerprints"
  { cat "$point/agentify_commerce.fingerprints"
    grep '^public\.' "$point/agentify_scanner.fingerprints"
    sed -n 's/^drizzle\.__drizzle_migrations|/drizzle.scanner_migrations|/p' "$point/agentify_scanner.fingerprints"
  } | sort > "$point/one-database.expected"
  new exec -T postgres sh -s -- fingerprints agentify_commerce < "$move" | sort > "$point/one-database.fingerprints"
  diff "$point/one-database.expected" "$point/one-database.fingerprints" >&2 \
    || refuse "the moved tables differ from the restore point's, as above; agentify_scanner stays. The way back: $back"
  say "$(wc -l < "$point/one-database.fingerprints") tables hold the rows they held before, row for row"

  step="comparing the metabase views"
  views="select c.relname, pg_get_viewdef(c.oid), c.reloptions from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'metabase' and c.relkind = 'v' order by 1"
  new_sql() { new exec -T postgres psql -X -q -v ON_ERROR_STOP=1 -U agentify_commerce -At "$@"; }
  # The file installed into a copy of the scanner's schema, views aside, beside
  # what the host holds: PostgreSQL prints both definitions the same way.
  if git -C "$root" show ad5a772^:ops/dashboards/install-aggregate-views.sql > "$point/metabase-views.sql" \
    && new_sql -d postgres -c "SET client_min_messages = warning" -c "DROP DATABASE IF EXISTS one_database_views" -c "CREATE DATABASE one_database_views" \
    && new exec -T postgres pg_dump -U agentify_commerce --schema-only --exclude-schema=metabase --exclude-schema=pgboss agentify_scanner \
    | new_sql -d one_database_views > /dev/null \
    && new_sql -d one_database_views < "$point/metabase-views.sql" > /dev/null; then
    new_sql -d agentify_scanner -c "$views" > "$point/metabase-views.host"
    new_sql -d one_database_views -c "$views" > "$point/metabase-views.file"
    if diff "$point/metabase-views.file" "$point/metabase-views.host" > "$point/metabase-views.diff"; then
      say "the $(new_sql -d agentify_scanner -c "select count(*) from pg_views where schemaname = 'metabase'") metabase views are the ones ops/dashboards/install-aggregate-views.sql installs"
    else
      say "the metabase views differ from ops/dashboards/install-aggregate-views.sql as $point/metabase-views.diff records"
    fi
  else
    say "the metabase views could not be compared with the file, for the reason above; the restore point holds them as they were"
  fi
  new_sql -d postgres -c "SET client_min_messages = warning" -c "DROP DATABASE IF EXISTS one_database_views" || true
fi

step="dropping the scanner's database and renaming the one that stays"
new exec -T postgres sh -s -- finish < "$move"
password="$(new config --format json | python3 -c 'import json, sys; print(json.load(sys.stdin)["services"]["postgres"]["environment"]["POSTGRES_PASSWORD"])')"
printf '\\set password %s\nALTER ROLE agentify PASSWORD :'"'"'password'"'"';\n' "$password" \
  | new exec -T postgres psql -X -q -v ON_ERROR_STOP=1 -U agentify -d postgres
echo "done $point $stopped_at" > "$progress"
trap - ERR
say "$channel holds one database, agentify, in the project $new_project; the applications have been stopped for $(($(date +%s) - stopped_at)) seconds. Start them now with the release this script followed: sudo agentify-release <the same name>"
say "until that release takes a write, the way back is: $back"
