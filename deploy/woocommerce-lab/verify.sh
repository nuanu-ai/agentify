#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}

[[ -f compose.yaml ]] || fail "compose.yaml is missing"
[[ -x reset-store.sh ]] || fail "reset-store.sh is missing or not executable"
bash -n reset-store.sh

WOOCOMMERCE_DATA_ROOT=/tmp/agentify-woo-lab-static \
WORDPRESS_DB_PASSWORD=static-check \
MARIADB_ROOT_PASSWORD=static-check \
WORDPRESS_ADMIN_PASSWORD=static-check \
  docker compose config --quiet

if [[ "${1:-}" == "--static" ]]; then
  printf 'PASS: WooCommerce lab files resolve\n'
  exit 0
fi

docker_cmd=(sudo -n docker)
compose() { "${docker_cmd[@]}" compose "$@"; }
wp() { compose run --rm -T cli wp "$@"; }

compose ps --status running --services | grep -qx wordpress || fail "wordpress is not running"
compose ps --status running --services | grep -qx db || fail "database is not running"
compose ps --status running --services | grep -qx caddy || fail "caddy is not running"

products_json="$(curl -fsS 'https://woo.nuanu.ai/wp-json/wc/store/v1/products?per_page=100')"
PRODUCTS_JSON="$products_json" python3 - <<'PY'
import json
import os

products = json.loads(os.environ["PRODUCTS_JSON"])
expected = {
    "Coffee & Brunch Gift Card",
    "Dinner for Two Gift Card",
    "Wellness Day Gift Card",
    "Creative Workshop Pass",
    "Weekend Escape Gift Card",
}
actual = {product["name"] for product in products}
if actual != expected:
    raise SystemExit(f"FAIL: unexpected catalogue: {sorted(actual)}")
if any(not product.get("is_purchasable") for product in products):
    raise SystemExit("FAIL: every seeded product must be purchasable")
print("PASS: public Store API exposes the five seeded products")
PY

enabled_gateways="$(wp wc payment_gateway list --user=admin --format=json | \
  python3 -c 'import json,sys; print(" ".join(x["id"] for x in json.load(sys.stdin) if x.get("enabled")))')"
[[ -z "$enabled_gateways" ]] || fail "payment gateways enabled: $enabled_gateways"

[[ "$(wp option get blogname)" == "Nuanu Digital Gifts — Test Store" ]] || \
  fail "unexpected store title"

printf 'PASS: storefront is healthy and all payment gateways are disabled\n'
