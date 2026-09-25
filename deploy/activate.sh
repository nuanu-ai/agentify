#!/usr/bin/env bash
# Activates one revision on one channel. agentify-release runs it as root,
# from the checkout of the revision it releases, with the five images pinned
# by digest in AGENTIFY_*_IMAGE:
#
#   deploy/activate.sh test|production <full revision>
#
# Every refusal is one sentence on stderr. Exit 75 means something was in the
# way (the lock, another unfinished transition, images that did not arrive)
# and nothing was stopped.
#
# Everything that can refuse runs before anything stops. Then the four
# applications stop for about a minute: a restore point of the database, the
# migrations, the start of the new release. Before the stop, the channel's
# transition record (deploy/transition) is written, and it follows the run:
# stopped, dumped, migrating, and started, which is on disk before the new
# release starts and may take writes. It names the previous revision, the new
# one and their tags, the restore point and the cards on sale before. A
# verified release writes `current` and only then removes the record. Nothing
# here restores a database; only a person does, with agentify-release
# --restore. A failure or a signal:
#
#   before the stop      changes nothing.
#   stopped, dumped      leaves the databases untouched: the stopped services
#                        start again, and the transition ends, or, when this
#                        was a fix-forward, the unverified release it was to
#                        fix gets its record back.
#   migrating            leaves the four applications stopped and the record
#                        as it is: the channel is down, and a person either
#                        runs the same release again or restores.
#   started              restores nothing, ever.
#
# A run that finds a record another run left (deploy/README.md, "When a
# release fails"): for the same revision, it carries on, with the record's
# restore point and cards, and after `started` only forward, never stopping;
# for another revision after `started`, it goes ahead if that revision moves
# forward from the record's, with a fresh restore point, and is refused if
# not; before `started`, another revision waits until a person releases the
# record's revision again or restores its restore point; and while a restore
# is unfinished, everything waits. With no record, a run of the revision the
# channel runs checks it again without stopping anything.
set -Eeuo pipefail
umask 077

channel="${1:-}" revision="${2:-}"
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
images="$root/deploy/images.env" state="/var/lib/agentify/${1:-}" backups="/var/backups/agentify/${1:-}"
record="$state/transition" mode=release from="" cards="" backup="" move="" down=""
phase=checking step=activation checker=""
# `down` says what runs when an earlier run left the channel stopped.
refuse() { echo "activate: $*$down" >&2; exit 1; }
later() { echo "activate: $*; this run stopped nothing, and running it again later may go through.$down" >&2; exit 75; }
at() { step="$1"; echo "activate: $step" >&2; }
stack() { "$root/deploy/stack.sh" "$channel" "$@"; }
transition() { "$root/deploy/transition" "$record" "$@"; }
named() { local tags; tags="$(transition tags "$1")"; echo "$1${tags:+ ($tags)}"; }
restart() { mapfile -t old < <(stack ps -aq gateway cabinet scanner scanner-worker); ((${#old[@]} == 0)) || docker start "${old[@]}" >/dev/null; }
running() { stack ps --status running --format '{{.Service}}' gateway cabinet scanner scanner-worker | sort | paste -sd ' ' -; }
fail() {
  local code=$?
  ((BASH_SUBSHELL == 0)) || exit "$code"
  # The way back must not be cut short by a second signal.
  trap - ERR
  trap '' INT TERM HUP
  [[ -z $checker ]] || docker rm -f "$checker" >/dev/null 2>&1 || true
  [[ $from != none ]] || move="; this channel had no release by this command before, so nothing older than that was started"
  case $phase in
    checking) echo "activate: $step failed; nothing was stopped.$down" >&2 ;;
    stopped)
      [[ -z $backup ]] || rm -rf "$backup.partial"
      # No migration ran. A fix-forward's previous release is itself
      # unverified, so its record comes back rather than none.
      if restart; then
        if [[ -n $to && $to != "$revision" ]]; then
          transition set from="$was" to="$to" restore="$point" phase=started cards="$kept" from_tags="$was_tags" to_tags="$to_tags"
        else
          transition clear
        fi
      fi
      echo "activate: $step failed before any migration, so the databases are as they were; running now: $(running)$move." >&2 ;;
    migrating)
      echo "activate: $step failed while migrating, so the databases may hold part of $(named "$revision")'s migrations; gateway, cabinet, scanner and scanner-worker stay stopped, and the channel is down. Nothing restores by itself. Once the cause is fixed, release $(named "$revision") again, which carries the migrations on; or put the databases back as they were before them with  sudo agentify-release --restore $backup" >&2 ;;
    started)
      if [[ $mode == reverify ]]; then
        echo "activate: $step failed while checking $(named "$revision") again; nothing was stopped or restored, and running now: $(running)." >&2
      else
        echo "activate: $step failed after $(named "$revision") started and could take writes, so nothing was restored, and nothing will be: it runs unverified. Release it again once the cause is fixed, or a revision that moves forward from it; $backup holds the data from before its migrations, and restoring it with agentify-release --restore would lose everything written since${edge_file:+, and $backup/Caddyfile the route table the edge had before}." >&2
      fi ;;
  esac
  exit 1
}
trap fail ERR
trap 'step="$step (interrupted)"; fail' INT TERM HUP

case "$channel" in
  test) origin=test.agentify.ad network=eip155:84532 ;;
  production) origin=agentify.ad network=eip155:8453 ;;
  *) refuse "usage: deploy/activate.sh test|production <full revision>" ;;
esac
[[ $revision =~ ^[0-9a-f]{40}$ ]] || refuse "the revision must be one full commit SHA."
[[ $EUID -eq 0 ]] || refuse "activation runs as root."
[[ $(git -C "$root" rev-parse HEAD) == "$revision" && -z $(git -C "$root" status --porcelain) ]] \
  || refuse "$root is not a clean checkout of $revision; run the activate.sh of the revision being released."

exec 9>/run/lock/agentify-release.lock
flock -n 9 || { echo "activate: another activation, a restore or the privacy job holds the release lock; nothing was changed." >&2; exit 75; }
# The one-time move to one database keeps its progress here (deploy/README.md,
# "One database"). Until it says done, the database volume is a copy in the
# middle of a move, and nothing may start on it.
read -r moving _ < "$state/one-database" 2>/dev/null || moving=""
[[ -z $moving || $moving == "done" ]] \
  || refuse "$state/one-database says the move to one database stopped at $moving; finish it with deploy/one-database.sh $channel, or go back with deploy/one-database.sh $channel --back. Nothing was stopped."

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
[[ -z $(docker ps -q --filter "label=com.docker.compose.project=$project" --filter label=com.docker.compose.oneoff=True) ]] \
  || later "a one-off container of $project from an earlier run is still working"
# The transition another run left, if any, and what it allows.
open="$(transition show)" \
  || refuse "$record cannot be read, so what the databases hold is unknown; deploy/README.md, \"The transition record\", says how to move it aside."
IFS='|' read -r was to point reached kept restoring was_tags to_tags <<<"$open"
if [[ -n $restoring || ( -n $to && $reached != started ) ]]; then
  now="$(running)"
  down=" ${restoring:+A restore of $point}${restoring:-The release of $(named "$to")} is unfinished, and ${now:+running now: $now}${now:-none of gateway, cabinet, scanner and scanner-worker runs, so the channel is down}."
fi
if [[ -n $restoring ]]; then
  later "a restore of $point began and did not finish; run  sudo agentify-release --restore $point  until it succeeds"
elif [[ -n $to && $to == "$revision" ]]; then
  [[ $reached == stopped || -d $point ]] \
    || refuse "the restore point $point of the unfinished release of $(named "$revision") is gone; a person has to decide what the databases hold before anything is released."
  mode=resume from=$was backup=$point cards=$kept
  [[ $reached != started ]] || mode=forward
elif [[ -n $to && $reached == started ]]; then
  git -C "$root" merge-base --is-ancestor "$to" "$revision" 2>/dev/null \
    || refuse "$(named "$to") started without being verified, and $(named "$revision") does not move forward from it; release it again, or a revision that moves forward from it."
  from=$to cards=$kept
elif [[ -n $to ]]; then
  back="put the databases back with  sudo agentify-release --restore $point"
  [[ -d $point ]] || back="move $record aside, since it stopped before its restore point was taken and no migration ran (deploy/README.md)"
  later "the release of $(named "$to") stopped at $reached and did not finish; release it again, or $back, before releasing $(named "$revision")"
else
  from="$(cat "$state/current" 2>/dev/null)" || true
  from="${from:-none}"
  [[ $from != "$revision" ]] || mode=reverify
fi
timeout 30m "$root/deploy/stack.sh" "$channel" --profile jobs pull --policy missing --quiet \
  || later "the images in $images did not arrive, for the reasons above or within 30 minutes"
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
# The scanner's own start, alone and with no network: its entrypoint's checks,
# then its /api/health/live, which validates its whole configuration without a
# database or a provider.
# Its environment reaches docker through a pipe, never a file.
checker=agentify-scanner-check
docker rm -f "$checker" >/dev/null 2>&1 || true
docker run -d --name "$checker" --network none --env-file <(python3 -c 'import json, sys
for key, value in json.load(sys.stdin)["services"]["scanner"]["environment"].items():
    print(f"{key}={str(value).replace(chr(36) * 2, chr(36))}")' <<<"$rendered") \
  "$(sed -n 's/^AGENTIFY_SCANNER_IMAGE=//p' "$images")" >/dev/null
verdict=silent
for _ in {1..60}; do
  [[ $(docker inspect -f '{{.State.Running}}' "$checker") == true ]] || { verdict=stopped; break; }
  verdict="$(docker exec "$checker" node -e "fetch('http://127.0.0.1:3000/api/health/live').then(r => console.log(r.status)).catch(() => console.log('silent'))")" \
    || verdict=silent
  [[ $verdict == silent ]] || break
  sleep 1
done
if [[ $verdict == stopped ]]; then docker logs --tail 3 "$checker" >&2; fi
docker rm -f "$checker" >/dev/null
checker=""
case $verdict in
  200) ;;
  stopped) refuse "the scanner stopped at its own start, for the reason above; nothing was stopped." ;;
  silent) refuse "the scanner did not answer its health route within a minute of its own start; nothing was stopped." ;;
  *) refuse "the scanner's health route answered $verdict at its own start, so it finds its configuration invalid; nothing was stopped." ;;
esac
# Containers are found the way Compose finds them, by label: a recreate cut
# short leaves one running under a temporary name.
running="$(stack ps -aq postgres | xargs -r docker inspect -f '{{.Image}}' | sort -u)"
[[ -z $running || $running == "$(docker image inspect -f '{{.Id}}' "$(stack config --images postgres)")" ]] \
  || refuse "the postgres service runs another image than deploy/compose.images.yaml pins, and a database upgrade is a change of its own; nothing was stopped."
# The database's volume is external, so without it Compose would refuse only
# after the stop: a host that ran two databases gets it from
# deploy/one-database.sh, and a new host creates it (deploy/README.md).
volume="$(python3 -c 'import json, sys; print(json.load(sys.stdin)["volumes"]["agentify-postgres"]["name"])' <<<"$rendered")"
docker volume inspect "$volume" >/dev/null 2>&1 \
  || refuse "the volume $volume, which holds the channel's database, does not exist, so nothing was stopped; deploy/README.md says how a host gets it."
if [[ $channel == production ]]; then
  address=127.0.0.1:443
  edge=agentify-edge-caddy-1 caddy=docker.io/library/caddy@sha256:ae4458638da8e1a91aafffb231c5f8778e964bca650c8a8cb23a7e8ac557aa3c
  read -r edge_running edge_image edge_address edge_mount edge_file < <(docker inspect -f \
    '{{.State.Running}} {{.Image}} {{with index .NetworkSettings.Networks "agentify-ingress"}}{{.IPAddress}}{{end}} {{range .Mounts}}{{if eq .Destination "/etc/caddy/Caddyfile"}}{{.Type}} {{.Source}}{{end}}{{end}}' \
    "$edge" 2>/dev/null) || true
  [[ $edge_running == true && $edge_image == "$(docker image inspect -f '{{.Id}}' "$caddy" 2>/dev/null)" && $edge_address == 172.30.80.2 && $edge_mount == bind && -f $edge_file ]] \
    || refuse "$edge is not the reviewed edge, the pinned Caddy running at 172.30.80.2 with its Caddyfile bound from the host; nothing was stopped."
  # The route table is written over the edge's own after the start, so the
  # edge's Caddy loads it first, without starting it or reaching the network.
  docker exec -i "$edge" caddy validate --adapter caddyfile --config /dev/stdin < "$root/deploy/edge/Caddyfile" >/dev/null \
    || refuse "the edge's Caddy does not accept deploy/edge/Caddyfile, for the reason above; nothing was stopped."
else
  address="$(stack port web 443 2>/dev/null)" || address=unknown
fi
# The cards on sale now, which the release is held to afterwards, one per line
# in a file; none compared when nothing answers yet. A transition keeps the
# file it started with.
if [[ -z $to ]]; then
  cards="$state/cards-before"
  curl -sS --max-time 20 --connect-to "$origin:443:$address" "https://$origin/x402/catalog" 2>/dev/null \
    | python3 -c 'import json, sys; print("\n".join(sorted(item["id"] for item in json.load(sys.stdin)["items"])))' > "$cards" 2>/dev/null \
    || cards=""
fi

if [[ $mode == release ]]; then backup="$backups/$(date -u +%Y%m%dT%H%M%SZ)-$from-before-$revision"; fi
if [[ ( $mode == release || $mode == resume ) && ! -d $backup ]]; then
  mkdir -p "$backups"
  size="$(stack exec -T postgres psql -U agentify -d postgres -Atc \
    'select coalesce(sum(pg_database_size(datname)), 0) from pg_database' 2>/dev/null || echo 0)"
  free="$(df -B1 --output=avail "$backups" | tail -n 1)"
  ((free > size + (1 << 30))) \
    || refuse "$backups has $((free >> 20)) MiB free, and a restore point of $((size >> 20)) MiB of databases needs that and a GiB more; nothing was stopped."
fi

# The database mounts its init scripts from here rather than from the
# checkout, so a release whose scripts and database image are unchanged leaves
# the database's container alone. Unchanged scripts are not touched; changed
# ones are copied beside the old set and renamed into place, readable by the
# database's own user. A run stopped between the two renames leaves the path
# missing until the next release: the database reads it only on an empty
# volume.
init="$state/postgres-init"
if ! diff -r "$root/deploy/postgres-init" "$init" >/dev/null 2>&1; then
  at "installing the database's init scripts in $init"
  rm -rf "$init.new" "$init.old"
  (umask 022 && install -d -m 755 /var/lib/agentify "$state" && cp -R "$root/deploy/postgres-init" "$init.new")
  if [[ -e $init ]]; then mv "$init" "$init.old"; fi
  mv "$init.new" "$init"
  rm -rf "$init.old"
fi

previous="$(docker ps -aq --filter "label=com.docker.compose.project=$project" | xargs -r docker inspect -f '{{.Image}}')"
if [[ $mode == release || $mode == resume ]]; then
  at "stopping gateway, cabinet, scanner and scanner-worker"
  phase=stopped
  [[ $reached != migrating ]] || phase=migrating
  if [[ $mode == release ]]; then
    [[ -z $cards ]] || sync "$cards"
    transition set from="$from" to="$revision" restore="$backup" phase=stopped cards="$cards" \
      from_tags="$(transition tags "$from")" to_tags="$(transition tags "$revision")"
  fi
  stack stop --timeout 60 gateway cabinet scanner scanner-worker
  at "starting the database"
  stack up -d --wait --no-deps postgres
  if [[ -d $backup ]]; then
    at "reusing the restore point $backup of the unfinished release"
  else
    at "taking the restore point $backup"
    rm -rf "$backups"/*.partial
    mkdir "$backup.partial"
    stack exec -T postgres pg_dump -U agentify -Fc agentify > "$backup.partial/agentify.dump"
    [[ $channel == test ]] || cp "$edge_file" "$backup.partial/Caddyfile"
    # On disk before any migration relies on them.
    sync "$backup.partial"/*
    mv "$backup.partial" "$backup"
    sync "$backup" "$backups"
    transition set phase=dumped
  fi
  transition set phase=migrating
  phase=migrating
elif [[ $mode == forward ]]; then
  at "carrying $revision forward: it started without being verified, so nothing stops and nothing is restored"
  phase=started
fi
if [[ $mode == reverify ]]; then
  at "checking $revision again: the channel already runs it, so nothing stops"
else
  at "migrating the scanner's tables"
  stack run --rm --no-deps -T scanner-migrate
  at "migrating the gateway's and the cabinet's tables"
  stack run --rm --no-deps -T migrate
  transition set phase=started
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
at "checking the cards on sale"
# Read-only: a GET on a purchase address is always answered with its payment
# challenge and never read for payment. The catalog is one unpaged document.
python3 - "$origin" "$address" "$network" "$cards" <<'PY' \
  || refuse "the cards on sale do not answer as they did before the release, for the reason above, so $revision runs unverified."
import base64, json, subprocess, sys, urllib.parse
origin, address, network, before = sys.argv[1:5]
def get(url, *flags):
    return subprocess.run(["curl", "-sS", "--max-time", "20", "--connect-to", f"{origin}:443:{address}", *flags, url],
                          capture_output=True, text=True, check=True).stdout
cards = sorted(item["id"] for item in json.loads(get(f"https://{origin}/x402/catalog"))["items"])
known = set(open(before).read().split()) if before else None
gone = sorted(known - set(cards)) if known is not None else []
if gone:
    sys.exit(f"activate: {len(gone)} card(s) on sale before the release are gone from the catalog: {' '.join(gone)}")
for card in cards:
    url = f"https://{origin}/x402/{urllib.parse.quote(card, safe='')}/purchase"
    head = get(url, "-o", "/dev/null", "-D", "-").splitlines()
    status = head[0].split()[1] if head else "nothing"
    header = next((line.split(":", 1)[1].strip() for line in head if line.lower().startswith("payment-required:")), "")
    challenge = json.loads(base64.b64decode(header)) if status == "402" and header else {}
    accepts = challenge.get("accepts") or [{}]
    if challenge.get("resource", {}).get("url") != url or any(a.get("network") != network for a in accepts):
        sys.exit(f"activate: card {card} answered {status} without a payment challenge for {url} on {network}")
compared = "none compared, since nothing answered before" if known is None else f"{len(known)} compared"
print(f"activate: {len(cards)} card(s) on sale ({compared}), each answering its payment challenge on {network}", file=sys.stderr)
PY

at "scheduling the privacy job"
# It never runs while a transition is open: it would run this release's job
# on a schema the release may not have finished with.
printf 'SHELL=/bin/bash\n23 4 * * * root if [[ -e %q ]]; then logger -t agentify-release "the nightly privacy job skipped: %s names an unfinished release or restore"; else flock -n /run/lock/agentify-release.lock %q %s --profile jobs run --rm --no-deps -T scanner-privacy; fi\n' \
  "$record" "$record" "$root/deploy/stack.sh" "$channel" > /etc/cron.d/agentify-release
chmod 644 /etc/cron.d/agentify-release

trap - ERR INT TERM HUP
transition finish "$revision"
rm -f "$state/cards-before"
# The databases a restore replaced stay until a release after it is verified.
for replaced in $(stack exec -T postgres psql -U agentify -d postgres -Atc "select datname from pg_database where datname like '%\_replaced\_%'"); do
  stack exec -T postgres psql -U agentify -d postgres -q -c "DROP DATABASE \"$replaced\" WITH (FORCE)" \
    || echo "activate: $replaced stays, and the next verified release tries again." >&2
done
# The five newest restore points are kept; older ones go.
[[ ! -d $backups ]] || find "$backups" -mindepth 1 -maxdepth 1 -type d -name '*-before-*' ! -name '*.partial' | sort | head -n -5 | xargs -r rm -rf
current="$(while IFS='=' read -r _ reference; do docker image inspect -f '{{.Id}}' "$reference"; done < "$images")"
if [[ $previous != *"$(head -n 1 <<<"$current")"* ]]; then
  at "removing first-party images older than the previous release"
  for id in $(docker image ls -q --no-trunc --filter label=org.opencontainers.image.source=https://github.com/nuanu-ai/agentify | sort -u); do
    [[ "$previous $current" == *"$id"* ]] || docker image rm "$id" >/dev/null 2>&1 || true
  done
fi
echo "activate: $channel runs $(named "$revision") and answers on every route and card checked." >&2
