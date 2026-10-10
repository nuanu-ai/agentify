#!/usr/bin/env bash
# The probe of docs/research/41-woo-parcel-probe.md: a shipping rate from a
# WooCommerce shop's Store API cart, asked the way a client with no browser
# asks it. Read-only for the shop's catalogue; every exchange leaves a guest
# session, which is what P4 records.
#
#   SHOP=https://woo.nuanu.ai ./probe.sh > results.txt
set -euo pipefail
shop="${SHOP:-https://woo.nuanu.ai}"
api="$shop/wp-json/wc/store/v1"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

# One call: method, path, token, body. Prints "status seconds" and keeps the
# headers and the body in $work for the summary below.
call() {
  local method="$1" path="$2" token="$3" body="${4:-}"
  local args=(-sS -X "$method" -D "$work/headers" -o "$work/body" -w '%{http_code} %{time_total}'
    -H 'accept: application/json')
  [[ -n "$token" ]] && args+=(-H "Cart-Token: $token")
  [[ -n "$body" ]] && args+=(-H 'content-type: application/json' --data "$body")
  curl "${args[@]}" "$api$path"
}

token_of() { grep -i '^cart-token:' "$work/headers" | head -1 | cut -d' ' -f2 | tr -d '\r'; }

# The cart's shipping facts, without the address the shop echoes back.
summary() {
  python3 -I -c '
import json, sys
body = json.load(open(sys.argv[1]))
if "code" in body:
    print("  error code:", body["code"]); sys.exit()
items = [item["id"] for item in body.get("items", [])]
print("  items:", items, "needs_shipping:", body.get("needs_shipping"))
for package in body.get("shipping_rates", []):
    rates = package.get("shipping_rates", [])
    print("  package", package.get("package_id"), "rates:", len(rates))
    for rate in rates:
        print("   ", {key: rate.get(key) for key in
          ("rate_id", "method_id", "instance_id", "name", "price", "taxes",
           "currency_code", "currency_minor_unit")})
' "$work/body"
}

exchange() {
  local label="$1" product="$2" locality="$3"
  echo "== $label: product $product, $locality"
  local said token
  said="$(call GET /cart "")"
  token="$(token_of)"
  echo "  GET /cart -> $said, cart token: $([[ -n "$token" ]] && echo yes || echo no)," \
    "nonce header: $(grep -qi '^nonce:' "$work/headers" && echo yes || echo no)"
  said="$(call POST /cart/add-item "$token" "{\"id\":$product,\"quantity\":1}")"
  echo "  POST /cart/add-item (no nonce) -> $said"
  summary
  said="$(call POST /cart/update-customer "$token" "{\"shipping_address\":$locality}")"
  echo "  POST /cart/update-customer -> $said"
  summary
}

exchange "P2 Bali" 28 '{"country":"ID","state":"BA","city":"Denpasar","postcode":"80361"}'
exchange "P2 Jakarta" 28 '{"country":"ID","state":"JK","city":"Jakarta","postcode":"10110"}'
exchange "P2 San Francisco" 28 '{"country":"US","state":"CA","city":"San Francisco","postcode":"94105"}'
exchange "P2 New York" 28 '{"country":"US","state":"NY","city":"New York","postcode":"10001"}'
exchange "P3 Berlin" 28 '{"country":"DE","city":"Berlin","postcode":"10115"}'
exchange "Negative control: a virtual gift card" 12 '{"country":"ID","state":"JK","city":"Jakarta","postcode":"10110"}'

echo "== P3 contrast: a product that does not exist"
said="$(call GET /cart "")"
token="$(token_of)"
echo "  POST /cart/add-item id 999999 -> $(call POST /cart/add-item "$token" '{"id":999999,"quantity":1}')"
summary
