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

baseline="$WOOCOMMERCE_DATA_ROOT/baseline"
[[ -s "$baseline/wordpress.sql.gz" ]] || fail "database baseline is missing"
[[ -s "$baseline/wordpress.tar.gz" ]] || fail "WordPress baseline is missing"

docker_cmd=(sudo -n docker)
compose() { "${docker_cmd[@]}" compose "$@"; }
wp() { compose run --rm -T cli wp "$@"; }

sentinel_title="Reset mutation sentinel $(date +%s)"
wp post create --post_type=product --post_status=publish \
  --post_title="$sentinel_title" --porcelain >/dev/null
wp post list --post_type=product --title="$sentinel_title" --format=count | grep -qx 1 || \
  fail "reset mutation was not created"

preserved_marker="$WOOCOMMERCE_DATA_ROOT/caddy-data/.reset-preserve-sentinel"
printf 'preserve me\n' | sudo -n tee "$preserved_marker" >/dev/null

started_at="$(date +%s)"
./reset-store.sh >/tmp/agentify-woo-reset.log
elapsed="$(( $(date +%s) - started_at ))"

wp post list --post_type=product --title="$sentinel_title" --format=count | grep -qx 0 || \
  fail "experimental product survived reset"
[[ -f "$preserved_marker" ]] || fail "Caddy state was deleted during reset"
(( elapsed < 60 )) || fail "local reset took ${elapsed}s"

printf 'PASS: local baseline removed the mutation in %ss and preserved Caddy state\n' "$elapsed"
