#!/usr/bin/env bash
# Activates one revision on one channel. agentify-release runs it as root,
# from the checkout of the revision it releases, with the five images pinned
# by digest in AGENTIFY_*_IMAGE:
#
#   deploy/activate.sh test|production <full revision>
#
# Every refusal is one sentence on stderr. Exit 75 means something was in the
# way (the lock, an earlier run's migration) and nothing was stopped. Running
# it again is always safe.
#
# Everything that can refuse runs before anything stops. Then the four
# applications stop for about a minute: a restore point of both databases,
# the migrations, the start of the new release. What a failure, or a signal,
# does depends on how far the run got:
#
#   before the stop      nothing changed.
#   before the first     the databases are untouched; the stopped services
#   migration            start again on the previous release.
#   from the first       both databases are restored from the restore point
#   migration until the  taken after the stop, which loses nothing because
#   new release starts   nothing wrote in between, and the previous release
#                        starts again. If the restore fails, all four stay
#                        stopped and the message says what to run.
#   once it has started  the new release may have taken writes, so nothing is
#                        restored and the message says so.
#
# A run that stops before it finishes leaves `pending` in the channel's state
# directory, naming the restore point of the unfinished release. Running the
# same revision again reuses that restore point rather than dumping data its
# migrations already changed, and any other revision is refused until the
# unfinished one is finished or its restore point restored. When the channel
# already runs the revision, a run checks it again without stopping anything.
set -Eeuo pipefail
umask 077

channel="${1:-}" revision="${2:-}"
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
images="$root/deploy/images.env" state="/var/lib/agentify/${1:-}" backups="/var/backups/agentify/${1:-}"
phase=checking step=activation backup=""
refuse() { echo "activate: $*" >&2; exit 1; }
at() { step="$1"; echo "activate: $step" >&2; }
stack() { "$root/deploy/stack.sh" "$channel" "$@"; }
restart() { mapfile -t old < <(stack ps -aq gateway cabinet scanner scanner-worker); ((${#old[@]} == 0)) || docker start "${old[@]}" >/dev/null; }
fail() {
  local code=$?
  ((BASH_SUBSHELL == 0)) || exit "$code"
  # A second signal must not cut a restore short.
  trap - ERR
  trap '' INT TERM HUP
  case $phase in
    checking) echo "activate: $step failed; nothing was stopped." >&2 ;;
    stopped)
      [[ -z $backup ]] || rm -rf "$backup.partial"
      restart || true
      echo "activate: $step failed before any migration, so the databases are as they were and the services it stopped run the previous release again." >&2 ;;
    migrating)
      if "$root/deploy/restore.sh" "$backup" && restart; then
        echo "activate: $step failed, so both databases were restored from $backup, taken after the stop and before the first migration, and the previous release runs again; nothing written was lost, because nothing wrote in between." >&2
      else
        echo "activate: $step failed, and so did restoring $backup: the databases may hold part of $revision's migrations and part of the restore, and gateway, cabinet, scanner and scanner-worker stay stopped. Run  sudo $root/deploy/restore.sh $backup  until it succeeds, then release again the revision that ran before." >&2
      fi ;;
    started)
      echo "activate: $step failed after the new release started and could take writes, so nothing was restored: $revision runs unverified. Fix the cause and release $revision again${backup:+; $backup holds the data from before its migrations, and restoring it would lose everything written since}." >&2 ;;
  esac
  exit 1
}
trap fail ERR
trap 'step="$step (interrupted)"; fail' INT TERM HUP

case "$channel" in
  test) origin=test.agentify.ad ;;
  production) origin=agentify.ad ;;
  *) refuse "usage: deploy/activate.sh test|production <full revision>" ;;
esac
[[ $revision =~ ^[0-9a-f]{40}$ ]] || refuse "the revision must be one full commit SHA."
[[ $EUID -eq 0 ]] || refuse "activation runs as root."
[[ $(git -C "$root" rev-parse HEAD) == "$revision" && -z $(git -C "$root" status --porcelain) ]] \
  || refuse "$root is not a clean checkout of $revision; run the activate.sh of the revision being released."

exec 9>/run/lock/agentify-release.lock
flock -n 9 || { echo "activate: another activation, a restore or the privacy job holds the release lock; nothing was changed." >&2; exit 75; }

at "pulling the images of $revision"
pinned=""
for name in app web scanner scanner-worker scanner-privacy; do
  variable="AGENTIFY_$(tr a-z- A-Z_ <<<"$name")_IMAGE" reference="${!variable:-}"
  [[ $reference =~ ^ghcr\.io/nuanu-ai/agentify-$name@sha256:[0-9a-f]{64}$ ]] \
    || refuse "activation runs only images pinned by digest, and $variable is not one; agentify-release passes them."
  pinned+="$variable=$reference"$'\n'
done
# Written whole, and only once all five check out: this file is what the
# checkout's stack.sh and its nightly job read.
printf '%s' "$pinned" > "$images.new"
mv "$images.new" "$images"
unset AGENTIFY_APP_IMAGE AGENTIFY_WEB_IMAGE AGENTIFY_SCANNER_IMAGE AGENTIFY_SCANNER_WORKER_IMAGE AGENTIFY_SCANNER_PRIVACY_IMAGE
project="$(stack config --no-interpolate | sed -n '1s/^name: //p')"
if [[ -n $(docker ps -q --filter "label=com.docker.compose.project=$project" --filter label=com.docker.compose.oneoff=True) ]]; then
  echo "activate: a one-off container of $project from an earlier run is still working; nothing was changed." >&2; exit 75
fi
read -r from to backup < <(cat "$state/pending" 2>/dev/null) || true
[[ -z ${to:-} || $to == "$revision" ]] \
  || refuse "a release of $to did not finish and its migrations may have run; release $to again, or restore ${backup:-its restore point}, before releasing $revision."
[[ -z ${to:-} || -d $backup ]] || refuse "the restore point $backup of the unfinished release of $revision is gone; a person has to decide what the databases hold before anything is released."
reverify=false
if [[ -z ${to:-} && $(cat "$state/current" 2>/dev/null) == "$revision" ]]; then reverify=true; fi
stack --profile jobs pull --policy missing --quiet \
  || refuse "the images in $images could not be pulled, for the reasons above; nothing was stopped."
while IFS='=' read -r _ reference; do
  [[ $(docker image inspect -f '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$reference") == "$revision" ]] \
    || refuse "$reference does not carry the revision label $revision."
done < "$images"

at "checking the channel's configuration"
rendered="$(stack --profile jobs config --format json)" \
  || refuse "the channel's configuration does not render; the line above names what is missing."
docker run --rm -i --network none "$(sed -n 's/^AGENTIFY_APP_IMAGE=//p' "$images")" \
  node packages/core/src/deployment/preflight.mjs "$channel" <<<"$rendered" \
  || refuse "the preflight refused this configuration for the reasons above; nothing was stopped."
running="$(docker inspect -f '{{.Image}}' "$project-postgres-1" 2>/dev/null || true)"
[[ -z $running || $running == "$(docker image inspect -f '{{.Id}}' "$(stack config --images postgres)")" ]] \
  || refuse "$project-postgres-1 runs another image than deploy/compose.images.yaml pins, and a database upgrade is a change of its own; nothing was stopped."
if [[ $channel == production ]]; then
  address=127.0.0.1:443
  edge=agentify-edge-caddy-1 caddy=docker.io/library/caddy@sha256:ae4458638da8e1a91aafffb231c5f8778e964bca650c8a8cb23a7e8ac557aa3c
  read -r edge_running edge_image edge_address edge_mount edge_file < <(docker inspect -f \
    '{{.State.Running}} {{.Image}} {{with index .NetworkSettings.Networks "agentify-ingress"}}{{.IPAddress}}{{end}} {{range .Mounts}}{{if eq .Destination "/etc/caddy/Caddyfile"}}{{.Type}} {{.Source}}{{end}}{{end}}' \
    "$edge" 2>/dev/null) || true
  [[ $edge_running == true && $edge_image == "$(docker image inspect -f '{{.Id}}' "$caddy" 2>/dev/null)" && $edge_address == 172.30.80.2 && $edge_mount == bind && -f $edge_file ]] \
    || refuse "$edge is not the reviewed edge, the pinned Caddy running at 172.30.80.2 with its Caddyfile bound from the host; nothing was stopped."
else
  address="$(stack port web 443 2>/dev/null)" || address=unknown
fi

if [[ $reverify == false && -z $backup ]]; then
  from="$(docker inspect -f '{{.Image}}' "$project-gateway-1" 2>/dev/null \
    | xargs -r docker image inspect -f '{{index .Config.Labels "org.opencontainers.image.revision"}}' 2>/dev/null)" || true
  from="${from:-none}" backup="$backups/$(date -u +%Y%m%dT%H%M%SZ)-${from:-none}-before-$revision"
  mkdir -p "$backups"
  size="$(docker exec "$project-postgres-1" psql -U agentify_commerce -d postgres -Atc \
    'select coalesce(sum(pg_database_size(datname)), 0) from pg_database' 2>/dev/null || echo 0)"
  free="$(df -B1 --output=avail "$backups" | tail -n 1)"
  ((free > size + (1 << 30))) \
    || refuse "$backups has $((free >> 20)) MiB free, and a restore point of $((size >> 20)) MiB of databases needs that and a GiB more; nothing was stopped."
fi

previous="$(docker ps -aq --filter "label=com.docker.compose.project=$project" | xargs -r docker inspect -f '{{.Image}}')"
if [[ $reverify == false ]]; then
  at "stopping gateway, cabinet, scanner and scanner-worker"
  phase=stopped
  stack stop --timeout 60 gateway cabinet scanner scanner-worker
  stack up -d --wait --no-deps postgres
  if [[ -d $backup ]]; then
    at "reusing the restore point $backup of the unfinished release"
  else
    at "taking the restore point $backup"
    rm -rf "$backups"/*.partial
    mkdir "$backup.partial"
    for database in agentify_commerce agentify_scanner; do
      stack exec -T postgres pg_dump -U agentify_commerce -Fc "$database" > "$backup.partial/$database.dump"
    done
    [[ $channel == test ]] || cp "$edge_file" "$backup.partial/Caddyfile"
    mv "$backup.partial" "$backup"
    (umask 022 && install -d -m 755 /var/lib/agentify "$state" && echo "$from $revision $backup" > "$state/pending")
  fi
  phase=migrating
  at "migrating the scanner database"
  stack run --rm --no-deps -T scanner-migrate
  at "migrating the gateway and cabinet database"
  stack run --rm --no-deps -T migrate
else
  at "checking $revision again: the channel already runs it, so nothing stops"
fi

phase=started
at "starting the scanner"
# A scanner that will not start must not keep commerce down as well, so the
# gateway, the cabinet and the route table start whatever it did.
scanner=started
stack up -d --wait --no-deps scanner scanner-worker || scanner=failed
at "starting commerce and the route table"
stack up -d --wait --no-deps gateway cabinet web
[[ $scanner == started ]] \
  || refuse "the scanner did not start, for the reasons above; commerce runs $revision, and releasing it again after the fix finishes the release."
if [[ $channel == production ]]; then
  at "installing the edge's route table"
  # In place: the edge's bind mount holds this inode, and a new file renamed
  # over it would leave the running Caddy reading the old one.
  cat "$root/deploy/edge/Caddyfile" > "$edge_file"
  sync "$edge_file"
  docker exec "$edge" caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile
  docker exec "$edge" cat /etc/caddy/Caddyfile | cmp -s - "$root/deploy/edge/Caddyfile"
else
  address="$(stack port web 443)"
fi

at "checking the public routes"
for route in /=200 /owner=308 /api/health/live=200 /api/health=200 /cabinet/sign-in=200 \
  /cabinet/healthz=200 /docs/=200 /healthz=200 /x402/catalog=200 /admin=401; do
  status="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 20 --connect-to "$origin:443:$address" "https://$origin${route%=*}" || true)"
  [[ $status == "${route#*=}" ]] \
    || refuse "https://$origin${route%=*} answered ${status:-nothing} where ${route#*=} was expected, so $revision runs unverified."
done

at "scheduling the privacy job"
printf 'SHELL=/bin/bash\n23 4 * * * root flock -n /run/lock/agentify-release.lock %q %s --profile jobs run --rm --no-deps -T scanner-privacy\n' \
  "$root/deploy/stack.sh" "$channel" > /etc/cron.d/agentify-release
chmod 644 /etc/cron.d/agentify-release

trap - ERR INT TERM HUP
rm -f "$state/pending"
# The five newest restore points are kept; older ones go.
[[ ! -d $backups ]] || find "$backups" -mindepth 1 -maxdepth 1 -type d -name '*-before-*' ! -name '*.partial' | sort | head -n -5 | xargs -r rm -rf
current="$(while IFS='=' read -r _ reference; do docker image inspect -f '{{.Id}}' "$reference"; done < "$images")"
if [[ $previous != *"$(head -n 1 <<<"$current")"* ]]; then
  at "removing first-party images older than the previous release"
  for id in $(docker image ls -q --no-trunc --filter label=org.opencontainers.image.source=https://github.com/nuanu-ai/agentify | sort -u); do
    [[ "$previous $current" == *"$id"* ]] || docker image rm "$id" >/dev/null 2>&1 || true
  done
fi
echo "activate: $channel runs $revision and answers on every route checked." >&2
