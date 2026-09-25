#!/usr/bin/env bash
# The one Compose command line for a release channel.
#
#   sudo deploy/stack.sh test ps
#   sudo deploy/stack.sh production logs --tail 100 gateway
#
# A channel is one Compose project with one environment file (ADR-0016), and
# this is the only place that spells either out: activation, the nightly
# privacy job and a person on the host all reach the same stack through it.
# It describes the checkout it lives in. That checkout's directory is the
# project directory, and the images are the ones deploy/activate.sh recorded
# for it in deploy/images.env when it activated that revision.
#
# Both channels are the project agentify, each on its own host, so a container
# is agentify-<service>-1 wherever it runs (ADR-0025).
set -euo pipefail

channel="${1:-}"
case "$channel" in
  test) overlay=deploy/compose.agentify-test.yaml ;;
  production) overlay=deploy/compose.hetzner-commerce.yaml ;;
  *) echo "usage: deploy/stack.sh test|production <docker compose arguments>" >&2; exit 64 ;;
esac
shift

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
environment="/etc/agentify/$channel.env"
images="$root/deploy/images.env"
if [[ ! -r $environment ]]; then
  echo "stack: $environment is missing or not readable by this user; deploy/README.md, \"Setting up a host\", says what it holds." >&2
  exit 78
fi
# Compose reads a $ outside single quotes as the start of a variable: the value
# is cut short there, and every command prints the rest in a warning. A bcrypt
# hash is the usual victim, so the file is refused, naming the key only.
unquoted=""
while IFS= read -r line || [[ -n $line ]]; do
  [[ $line =~ ^[[:space:]]*([A-Za-z_][A-Za-z0-9_]*)=(.*)$ ]] || continue
  key="${BASH_REMATCH[1]}" value="${BASH_REMATCH[2]}"
  [[ $value != *'$'* || $value =~ ^\'[^\']*\'[[:space:]]*$ ]] || unquoted+="$key "
done < "$environment"
if [[ -n $unquoted ]]; then
  echo "stack: $environment holds a \$ outside single quotes in ${unquoted}- Compose would read what follows it as a variable, so write each such value inside single quotes." >&2
  exit 78
fi
if [[ ! -r $images ]]; then
  echo "stack: $images is missing, so this checkout names no images: deploy/activate.sh writes it when it activates the revision." >&2
  exit 78
fi

# The channel overlays mount the database's init scripts from here, a path no
# release changes; deploy/activate.sh keeps it equal to the checkout's copy.
export AGENTIFY_POSTGRES_INIT="/var/lib/agentify/$channel/postgres-init"
exec docker compose --project-directory "$root" --project-name agentify \
  --env-file "$environment" --env-file "$images" \
  -f "$root/compose.yaml" -f "$root/deploy/compose.public.yaml" \
  -f "$root/$overlay" -f "$root/deploy/compose.images.yaml" "$@"
