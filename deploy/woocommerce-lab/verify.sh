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
WOO_LAB_LISTEN_ADDRESS=127.0.0.1 \
WORDPRESS_DB_PASSWORD=static-check \
MARIADB_ROOT_PASSWORD=static-check \
WORDPRESS_ADMIN_PASSWORD=static-check \
  docker compose config --quiet

if [[ "${1:-}" == "--static" ]]; then
  printf 'PASS: WooCommerce lab files resolve\n'
  exit 0
fi

# The two addresses this check pins are deployment facts, not source: the
# shared public address the shop's hostname resolves to, and the ingress
# address behind it. Supply both; there is no default, because a default here
# would quietly pass the check against the wrong machine.
: "${WOO_LAB_PUBLIC_IP:?set WOO_LAB_PUBLIC_IP to the shared public address the shop hostname resolves to}"
: "${WOO_LAB_INGRESS_IP:?set WOO_LAB_INGRESS_IP to the ingress address behind that public address}"

docker_cmd=(sudo -n docker)
compose() { "${docker_cmd[@]}" compose "$@"; }
wp() { compose run --rm -T cli wp "$@"; }

compose ps --status running --services | grep -qx wordpress || fail "wordpress is not running"
compose ps --status running --services | grep -qx db || fail "database is not running"
compose ps --status running --services | grep -qx caddy || fail "caddy is not running"

resolved_addresses="$(getent ahostsv4 woo.nuanu.ai | awk '{print $1}' | sort -u)"
[[ "$resolved_addresses" == "$WOO_LAB_PUBLIC_IP" ]] || \
  fail "woo.nuanu.ai does not resolve only to the shared ingress: $resolved_addresses"
printf 'PASS: public DNS points woo.nuanu.ai at the shared ingress\n'

products_json="$(curl -fsS --connect-timeout 5 --max-time 20 \
  --resolve "woo.nuanu.ai:443:$WOO_LAB_INGRESS_IP" \
  'https://woo.nuanu.ai/wp-json/wc/store/v1/products?per_page=100')"
catalogue_json="$(wp wc product list --user=admin --status=publish --per_page=100 \
  --fields=name,price,type,purchasable,stock_status,manage_stock,sold_individually,virtual,downloadable,downloads,download_limit,download_expiry \
  --format=json)"
# The deny rule answers 403 whether or not a file is behind it, so the files
# themselves are also compared with the seed's copies, inside the WordPress
# container. A missing file makes sha256sum fail after hashing the others; the
# check below names whichever file has no hash.
shop_download_paths=()
for seed_file in seed/downloads/*; do
  shop_download_paths+=("/var/www/html/wp-content/uploads/woocommerce_uploads/${seed_file##*/}")
done
shop_file_hashes="$(compose exec -T wordpress sha256sum -- "${shop_download_paths[@]}" || true)"
PRODUCTS_JSON="$products_json" CATALOGUE_JSON="$catalogue_json" \
  SHOP_FILE_HASHES="$shop_file_hashes" \
  WOO_LAB_INGRESS_IP="$WOO_LAB_INGRESS_IP" python3 - <<'PY'
import hashlib
import html
import json
import os
import subprocess
from decimal import Decimal, InvalidOperation

# The seed creates two groups, and the lab exists to show the Agentify
# connector telling them apart. A gift card promises an experience that no
# file can deliver, so it carries none and the connector must name it and
# leave it in the shop. A download is the whole of what it promises, and it is
# shaped to the one class of product the connector imports.
GIFT_CARDS = {
    "Coffee & Brunch Gift Card",
    "Dinner for Two Gift Card",
    "Wellness Day Gift Card",
    "Creative Workshop Pass",
    "Weekend Escape Gift Card",
}
# Each download with its price as the seed types it: one with cents and one
# without, the two shapes a merchant types into WooCommerce.
DOWNLOADS = {
    "Gift Message Templates": "1.00",
    "Gift Wrapping Guide": "2",
}
SEEDED = GIFT_CARDS | set(DOWNLOADS)
PROTECTED_UPLOADS = "https://woo.nuanu.ai/wp-content/uploads/woocommerce_uploads/"
SHOP_UPLOADS = "/var/www/html/wp-content/uploads/woocommerce_uploads/"
SEED_DOWNLOADS = "seed/downloads"


def fail(message):
    raise SystemExit(f"FAIL: {message}")


# Exact counts as well as names, so that an empty or duplicated answer cannot
# pass for the catalogue.
public = json.loads(os.environ["PRODUCTS_JSON"])
public_names = {html.unescape(product["name"]) for product in public}
if len(public) != len(SEEDED) or public_names != SEEDED:
    fail(f"the public catalogue has {len(public)} products, not the seeded ones: {sorted(public_names)}")
if any(not product.get("is_purchasable") for product in public):
    fail("every seeded product must be purchasable")
if any(
    not product.get("images")
    or not product["images"][0].get("src", "").lower().endswith(".webp")
    for product in public
    if html.unescape(product["name"]) in GIFT_CARDS
):
    fail("every gift card must have a WebP product photo")
print("PASS: private ingress Store API exposes the seven seeded products")

listed = json.loads(os.environ["CATALOGUE_JSON"])
catalogue = {html.unescape(product.get("name", "")): product for product in listed}
if len(listed) != len(SEEDED) or set(catalogue) != SEEDED:
    fail(f"WP-CLI lists {len(listed)} published products, not the seeded ones: {sorted(catalogue)}")

# The public catalogue writes a price in cents, while WooCommerce keeps the
# price the merchant typed, with cents or without. The two must agree as
# amounts, and the downloads must keep both typed shapes.
for product in public:
    name = html.unescape(product["name"])
    prices = product.get("prices") or {}
    if prices.get("currency_code") != "USD" or prices.get("currency_minor_unit") != 2:
        fail(f"{name} is not priced in US dollars at two decimals in the public catalogue")
    typed = catalogue[name].get("price")
    try:
        public_amount = Decimal(prices.get("price")).scaleb(-2)
        typed_amount = Decimal(typed)
    except (InvalidOperation, TypeError):
        fail(f"{name} has a price that is not an amount: {prices.get('price')!r} public, {typed!r} typed")
    if public_amount != typed_amount:
        fail(f"{name} costs {public_amount} in the public catalogue but {typed} in WooCommerce")
typed_prices = {name: catalogue[name].get("price") for name in DOWNLOADS}
if typed_prices != DOWNLOADS:
    fail(f"the downloads must keep the prices the seed types, {DOWNLOADS}: {typed_prices}")
print("PASS: every public price equals, as an amount, the price WooCommerce keeps")

with_a_file = sorted(
    name
    for name in GIFT_CARDS
    if catalogue[name].get("downloadable") or catalogue[name].get("downloads")
)
if with_a_file:
    fail(f"gift cards must carry no downloadable file, so the connector refuses them: {with_a_file}")
print("PASS: the five gift cards carry no downloadable file")

seed_files = sorted(os.listdir(SEED_DOWNLOADS))
shop_hashes = {}
for line in os.environ["SHOP_FILE_HASHES"].splitlines():
    digest, _, path = line.partition("  ")
    if path.startswith(SHOP_UPLOADS):
        shop_hashes[path[len(SHOP_UPLOADS):]] = digest
served_names = []

for name in sorted(DOWNLOADS):
    product = catalogue[name]
    files = product.get("downloads") or []
    missing = [
        fact
        for fact, holds in (
            ("a simple product", product.get("type") == "simple"),
            ("purchasable", product.get("purchasable") is True),
            ("in stock", product.get("stock_status") == "instock"),
            ("without managed stock", product.get("manage_stock") is False),
            ("not sold individually", product.get("sold_individually") is False),
            ("virtual", product.get("virtual") is True),
            ("downloadable", product.get("downloadable") is True),
            ("with exactly one file", len(files) == 1),
            ("unlimited in download count", product.get("download_limit") == -1),
            ("without download expiry", product.get("download_expiry") == -1),
            (
                "with its file in WooCommerce's protected uploads",
                len(files) == 1 and files[0].get("file", "").startswith(PROTECTED_UPLOADS),
            ),
        )
        if not holds
    ]
    if missing:
        fail(f"{name} must be {'; '.join(missing)}")

    served_name = files[0]["file"][len(PROTECTED_UPLOADS):]
    if served_name not in seed_files:
        fail(f"the file of {name}, {served_name}, is not one of the files in {SEED_DOWNLOADS}")
    with open(os.path.join(SEED_DOWNLOADS, served_name), "rb") as seed_file:
        expected_digest = hashlib.sha256(seed_file.read()).hexdigest()
    if served_name not in shop_hashes:
        fail(f"the file of {name}, {served_name}, is missing from the shop")
    if shop_hashes[served_name] != expected_digest:
        fail(f"the file of {name} in the shop differs from {SEED_DOWNLOADS}/{served_name}")
    served_names.append(served_name)

    # The connector refuses a file that answers a request without an order's
    # download permission, so this asks the same question it does.
    answer = subprocess.run(
        [
            "curl", "-sS", "-o", "/dev/null", "-w", "%{http_code}",
            "--connect-timeout", "5", "--max-time", "20",
            "--resolve", f"woo.nuanu.ai:443:{os.environ['WOO_LAB_INGRESS_IP']}",
            files[0]["file"],
        ],
        capture_output=True,
        text=True,
    )
    if answer.returncode != 0:
        fail(f"could not request the file of {name}: {answer.stderr.strip()}")
    if answer.stdout not in ("401", "403"):
        fail(f"the file of {name} answered {answer.stdout} without an order permission")
if sorted(served_names) != seed_files:
    fail(f"each file in {SEED_DOWNLOADS} must belong to exactly one download: {sorted(served_names)}")
print("PASS: both downloads are in the connector's class, match the seed and need an order permission")
PY

# The connector reads these shop settings before it imports or sells a
# download, and refuses every product while any one of them differs.
for setting in \
  woocommerce_currency=USD \
  woocommerce_calc_taxes=no \
  woocommerce_file_download_method=force \
  woocommerce_downloads_redirect_fallback_allowed=no \
  woocommerce_downloads_require_login=no \
  woocommerce_downloads_grant_access_after_payment=yes; do
  option="${setting%%=*}"
  expected="${setting#*=}"
  actual="$(wp option get "$option")"
  [[ "$actual" == "$expected" ]] || fail "$option is '$actual'; the connector needs '$expected'"
done
printf 'PASS: the shop settings the connector reads are the ones it supports\n'

enabled_gateways="$(wp wc payment_gateway list --user=admin --format=json | \
  python3 -c 'import json,sys; print(" ".join(x["id"] for x in json.load(sys.stdin) if x.get("enabled")))')"
[[ -z "$enabled_gateways" ]] || fail "payment gateways enabled: $enabled_gateways"

[[ "$(wp option get blogname)" == "Test Gift Shop" ]] || \
  fail "unexpected store title"

printf 'PASS: storefront is healthy and all payment gateways are disabled\n'
