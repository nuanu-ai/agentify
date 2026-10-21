#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"

currency="${1:-IDR}"
if [[ "$currency" != IDR && "$currency" != USD ]]; then
  printf 'Usage: %s [IDR|USD]\n' "$0" >&2
  exit 2
fi

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}

[[ -f .env ]] || fail "the lab's .env is missing; run ./reset-store.sh first"
set -a
# shellcheck disable=SC1091
source .env
set +a

docker_cmd=(sudo -n docker)
compose() { "${docker_cmd[@]}" compose --profile realistic "$@"; }
wp() { compose run --rm -T cli wp "$@"; }

compose ps --status running --services | grep -qx wordpress || \
  fail "the shop is not running; run ./reset-store.sh first"

# The plugins visible on at least a fifth of the Indonesian shops in the
# census, each at a pinned version from wordpress.org. Elementor Pro, the sixth,
# is sold by its vendor rather than published there, and is not installed.
plugins=(
  elementor@4.3.5
  contact-form-7@6.2.3
  woo-xendit-virtual-accounts@8.0.0
  click-to-chat-for-whatsapp@4.45
  google-site-kit@1.190.0
)

# The seed runs first because it installs the hook that hands mail to the
# catcher, and a plugin may send mail as it is activated.
compose up -d mailpit
wp eval-file /seed/realistic.php "$currency"
for plugin in "${plugins[@]}"; do
  wp plugin install "${plugin%@*}" --version="${plugin#*@}" --force --activate
done
wp rewrite flush --hard

# A small proof that the profile took: the currency and its decimals as the
# public catalogue reports them, the size and make-up of that catalogue, the
# active plugins at their pinned versions, and bank transfer enabled.
store_pages=""
for page in 1 2; do
  store_pages+="$(compose exec -T wordpress curl -fsS \
    "http://localhost/wp-json/wc/store/v1/products?per_page=100&page=$page")"$'\n'
done
active_plugins="$(wp plugin list --status=active --fields=name,version --format=json)"
enabled_gateways="$(wp wc payment_gateway list --user=admin --format=json)"
STORE_PAGES="$store_pages" ACTIVE_PLUGINS="$active_plugins" \
  ENABLED_GATEWAYS="$enabled_gateways" CURRENCY="$currency" \
  PINNED="${plugins[*]}" python3 - <<'PY'
import json
import os


def fail(message):
    raise SystemExit(f"FAIL: {message}")


products = [p for page in os.environ["STORE_PAGES"].splitlines() if page for p in json.loads(page)]
currency = os.environ["CURRENCY"]
decimals = {"IDR": 0, "USD": 2}[currency]
if len(products) != 113:
    fail(f"the public catalogue lists {len(products)} products, not the profile's 113")
kinds = {p["type"] for p in products}
variable = sum(p["type"] == "variable" for p in products)
if kinds != {"simple", "variable"} or variable != 29:
    fail(f"the catalogue should hold 84 simple and 29 variable products: {variable} variable, types {sorted(kinds)}")
for product in products:
    prices = product["prices"]
    if prices["currency_code"] != currency or prices["currency_minor_unit"] != decimals:
        fail(f"{product['name']} is priced in {prices['currency_code']} at {prices['currency_minor_unit']} decimals")
print(f"PASS: the public catalogue lists 113 products, 29 of them variable, in {currency} at {decimals} decimals")

active = {p["name"]: p["version"] for p in json.loads(os.environ["ACTIVE_PLUGINS"])}
for pinned in os.environ["PINNED"].split():
    slug, version = pinned.split("@")
    if active.get(slug) != version:
        fail(f"{slug} should be active at {version}: {active.get(slug, 'not active')}")
print("PASS: the profile's plugins are active at their pinned versions")

enabled = sorted(g["id"] for g in json.loads(os.environ["ENABLED_GATEWAYS"]) if g.get("enabled"))
if "bacs" not in enabled:
    fail(f"bank transfer is not enabled: {enabled}")
print(f"PASS: payment methods enabled: {', '.join(enabled)}")
PY

printf '\nThe realistic profile is in place, priced in %s.\n' "$currency"
printf 'Mail the shop sends is read in the mail catcher on 127.0.0.1:8025 of this host.\n'
printf 'Run ./reset-store.sh to return to the baseline shop.\n'
