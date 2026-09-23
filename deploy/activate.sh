#!/usr/bin/env bash
# Activates one revision on one channel:
#
#   sudo deploy/activate.sh test|production <full revision>
#
# The pull agent runs it as root from the checkout of the revision it names,
# and a person can do the same. Running it again is always safe: each step
# finds its work done or does it again, and nothing a later step or a person
# needs is overwritten. Every refusal is one sentence on stderr. Exit 75 means
# the release lock, or a one-off container of an earlier run, was in the way
# and nothing was changed.
#
# PRODUCTION runs only the digests main's own build published for the
# revision: the pull agent reads them by the rule in the header of
# .github/workflows/images.yml and passes them as the five AGENTIFY_*_IMAGE
# variables. TEST runs ghcr.io/nuanu-ai/agentify-<name>:<revision>, which
# exists for every commit that was once the head of a pushed branch.
#
# The applications stop for about a minute, for a restore point and the
# migrations. Drizzle applies each migration runner's pending set in one
# transaction, and the runners go one after another: the scanner's, then,
# inside `migrate`, the gateway's and the cabinet's. A runner that fails
# leaves its own set unapplied and the runners before it committed. The
# stopped services then start again on the previous release, over those
# committed sets; that is safe while migrations only add, and the restore
# point is the way back when one does not.
# -E carries the ERR traps below into functions: every Compose call goes
# through `stack`, and without it a failed migration exits without starting
# the stopped services again.
set -Eeuo pipefail
umask 077

channel="${1:-}" revision="${2:-}"
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
images="$root/deploy/images.env" backup="/var/backups/agentify/${1:-}/${2:-}" step=""
refuse() { echo "activate: $*" >&2; exit 1; }
at() { step="$1"; echo "activate: $step" >&2; }
stack() { "$root/deploy/stack.sh" "$channel" "$@"; }

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
if ! flock -n 9; then
  echo "activate: another activation or the privacy job holds the release lock; nothing was changed." >&2; exit 75
fi

at "pulling the images of $revision"
for name in app web scanner scanner-worker scanner-privacy; do
  variable="AGENTIFY_$(tr a-z- A-Z_ <<<"$name")_IMAGE" reference="ghcr.io/nuanu-ai/agentify-$name:$revision"
  if [[ $channel == production ]]; then
    reference="${!variable:-}"
    [[ $reference =~ ^ghcr\.io/nuanu-ai/agentify-$name@sha256:[0-9a-f]{64}$ ]] \
      || refuse "production runs only the digests main's build published, and $variable is not one."
  fi
  echo "$variable=$reference"
done > "$images"
unset AGENTIFY_APP_IMAGE AGENTIFY_WEB_IMAGE AGENTIFY_SCANNER_IMAGE AGENTIFY_SCANNER_WORKER_IMAGE AGENTIFY_SCANNER_PRIVACY_IMAGE
project="$(stack config --no-interpolate | sed -n '1s/^name: //p')"
if [[ -n $(docker ps -q --filter "label=com.docker.compose.project=$project" --filter label=com.docker.compose.oneoff=True) ]]; then
  echo "activate: a one-off container of $project from an earlier run is still working; nothing was changed." >&2; exit 75
fi
stack --profile jobs pull --policy missing --quiet \
  || refuse "the images in $images could not be pulled; a commit has images only if it was once the head of a pushed branch."
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
  edge=agentify-edge-caddy-1 caddy=docker.io/library/caddy@sha256:ae4458638da8e1a91aafffb231c5f8778e964bca650c8a8cb23a7e8ac557aa3c
  read -r edge_running edge_image edge_address edge_mount edge_file < <(docker inspect -f \
    '{{.State.Running}} {{.Image}} {{with index .NetworkSettings.Networks "agentify-ingress"}}{{.IPAddress}}{{end}} {{range .Mounts}}{{if eq .Destination "/etc/caddy/Caddyfile"}}{{.Type}} {{.Source}}{{end}}{{end}}' \
    "$edge" 2>/dev/null) || true
  [[ $edge_running == true && $edge_image == "$(docker image inspect -f '{{.Id}}' "$caddy" 2>/dev/null)" && $edge_address == 172.30.80.2 && $edge_mount == bind && -f $edge_file ]] \
    || refuse "$edge is not the reviewed edge, the pinned Caddy running at 172.30.80.2 with its Caddyfile bound from the host; nothing was stopped."
fi

at "stopping gateway, cabinet, scanner and scanner-worker"
previous="$(docker ps -aq --filter "label=com.docker.compose.project=$project" | xargs -r docker inspect -f '{{.Image}}')"
restart() { mapfile -t old < <(stack ps -aq gateway cabinet scanner scanner-worker); ((${#old[@]} == 0)) || docker start "${old[@]}" >/dev/null; }
trap 'restart || true; echo "activate: $step failed, so the services it stopped run the previous release again, over any migration that committed before the failure; $backup is the restore point." >&2' ERR
stack stop gateway cabinet scanner scanner-worker

at "taking the restore point"
stack up -d --wait --no-deps postgres
if [[ ! -d $backup ]]; then
  rm -rf "$backup.partial" && mkdir -p "$backup.partial"
  for database in agentify_commerce agentify_scanner; do
    stack exec -T postgres pg_dump -U agentify_commerce -Fc "$database" > "$backup.partial/$database.dump"
  done
  [[ $channel == test ]] || cp "$edge_file" "$backup.partial/Caddyfile"
  mv "$backup.partial" "$backup"
fi

at "migrating the scanner database"
stack run --rm --no-deps -T scanner-migrate
at "migrating the gateway and cabinet database"
stack run --rm --no-deps -T migrate

trap 'echo "activate: $step failed after the migrations, so the previous release cannot simply start again on this database; fix the cause and run the activation again, or restore $backup." >&2' ERR
at "starting the scanner"
stack up -d --wait --no-deps scanner scanner-worker
at "starting commerce and the route table"
stack up -d --wait --no-deps gateway cabinet web
if [[ $channel == production ]]; then
  at "installing the edge's route table"
  # In place: the edge's bind mount holds this inode, and a new file renamed
  # over it would leave the running Caddy reading the old one.
  cat "$root/deploy/edge/Caddyfile" > "$edge_file" && sync "$edge_file"
  docker exec "$edge" caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile
  docker exec "$edge" cat /etc/caddy/Caddyfile | cmp -s - "$root/deploy/edge/Caddyfile"
fi

at "checking the public routes"
if [[ $channel == production ]]; then address=127.0.0.1:443; else address="$(stack port web 443)"; fi
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

trap - ERR
current="$(while IFS='=' read -r _ reference; do docker image inspect -f '{{.Id}}' "$reference"; done < "$images")"
if [[ $previous != *"$(head -n 1 <<<"$current")"* ]]; then
  at "removing first-party images older than the previous release"
  for id in $(docker image ls -q --no-trunc --filter label=org.opencontainers.image.source=https://github.com/nuanu-ai/agentify | sort -u); do
    [[ "$previous $current" == *"$id"* ]] || docker image rm "$id" >/dev/null 2>&1 || true
  done
fi
echo "activate: $channel runs $revision and answers on every route checked."
