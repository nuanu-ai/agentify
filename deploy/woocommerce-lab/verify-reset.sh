#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}

set -a
# shellcheck disable=SC1091
source .env
set +a

if docker info >/dev/null 2>&1; then
  docker_cmd=(docker)
else
  docker_cmd=(sudo -n docker)
fi
compose() { "${docker_cmd[@]}" compose "$@"; }
wp() { compose run --rm -T cli wp "$@"; }

sentinel_title="Reset mutation sentinel $(date +%s)"
wp post create --post_type=product --post_status=publish \
  --post_title="$sentinel_title" --porcelain >/dev/null
wp post list --post_type=product --title="$sentinel_title" --format=count | grep -qx 1 || \
  fail "reset mutation was not created"

in_lab() { compose run --rm --no-deps -T tools "$1"; }
in_lab 'echo "preserve me" >/lab/caddy-data/.reset-preserve-sentinel'

started_at="$(date +%s)"
switch_log="$(mktemp)"
./lab.sh switch basic >"$switch_log" 2>&1 || {
  cat "$switch_log" >&2
  fail "the switch to the basic profile failed"
}
elapsed="$(( $(date +%s) - started_at ))"

wp post list --post_type=product --title="$sentinel_title" --format=count | grep -qx 0 || \
  fail "experimental product survived the switch"
in_lab 'test -f /lab/caddy-data/.reset-preserve-sentinel' || fail "Caddy state was deleted during the switch"
in_lab 'rm -f /lab/caddy-data/.reset-preserve-sentinel'
(( elapsed < 60 )) || fail "switching to the basic profile took ${elapsed}s"

printf 'PASS: switching to the basic profile removed the mutation in %ss and kept Caddy state\n' "$elapsed"
