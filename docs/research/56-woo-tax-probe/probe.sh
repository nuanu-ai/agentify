#!/usr/bin/env bash
# The probe of docs/research/56-woo-tax-probe.md: what a WooCommerce shop with
# tax calculation on does with the prices the Agentify connector reads, the
# cart it asks for a parcel's rate and the paid order it creates. It runs
# against the throwaway shop setup.sh builds on this machine, never a real shop,
# and creates paid orders in it. probe.py builds the bodies and prints answers.
#
#   PROBE_STATE=/some/private/dir ./probe.sh > results.txt
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$here"
: "${PROBE_STATE:?set PROBE_STATE to the directory setup.sh wrote}"
set -a
# shellcheck disable=SC1091
source "$PROBE_STATE/env"
set +a
shop="http://localhost:${PROBE_PORT:-18456}"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

wpcli() { docker compose --env-file "$PROBE_STATE/env" run --rm -T cli wp "$@" 2>/dev/null; }
mode() { echo; echo "######## mode $*"; wpcli eval-file /probe/mode.php "$@"; }
option() { wpcli option update "$1" "$2" >/dev/null; echo "-- option $1 = $2"; }
py() { python3 -I "$here/probe.py" "$@"; }

# wc/v3 with the REST key. WooCommerce takes Basic auth only over HTTPS; the
# header stands in for the TLS proxy (see compose.yaml).
v3() {
  local method="$1" path="$2" body="${3:-}"
  local args=(-sS -X "$method" -o "$work/body" -w '%{http_code}' -u "$WOO_KEY:$WOO_SECRET"
    -H 'X-Forwarded-Proto: https' -H 'accept: application/json')
  [[ -n "$body" ]] && args+=(-H 'content-type: application/json' --data "$body")
  curl "${args[@]}" "$shop/wp-json/wc/v3$path"
}

# The Store API as the connector asks it: no cookie, no nonce, a cart token.
store() {
  local method="$1" path="$2" token="${3:-}" body="${4:-}"
  local args=(-sS -X "$method" -D "$work/headers" -o "$work/body" -w '%{http_code}'
    -H 'accept: application/json')
  [[ -n "$token" ]] && args+=(-H "Cart-Token: $token")
  [[ -n "$body" ]] && args+=(-H 'content-type: application/json' --data "$body")
  curl "${args[@]}" "$shop/wp-json/wc/store/v1$path"
}
token_of() { grep -i '^cart-token:' "$work/headers" | head -1 | cut -d' ' -f2 | tr -d '\r'; }

# Q1: the product's price as wc/v3 keeps it and as the Store API shows it.
prices() {
  local id="$1" label="$2" token="${3:-}" kept
  v3 GET "/products/$id" >/dev/null
  kept="$(py kept-price "$work/body")"
  store GET "/products/$id" "$token" >/dev/null
  py prices "$work/body" "$label" "$kept"
}

# A cart holding one product, placed at a locality if one is given; leaves the
# token in $cart_token and the quote in $work/cart.
cart_token=""
cart() {
  local id="$1" locality="${2:-}"
  store GET /cart >/dev/null
  cart_token="$(token_of)"
  store POST /cart/add-item "$cart_token" "{\"id\":$id,\"quantity\":1}" >/dev/null
  if [[ -n "$locality" ]]; then
    store POST /cart/update-customer "$cart_token" "{\"shipping_address\":$locality}" >/dev/null
  else
    store GET /cart "$cart_token" >/dev/null
  fi
  py cart "$work/body" "$work/cart"
}

# One paid order: a label, the amount it is held against, the body.
order() {
  local label="$1" expect="$2" body="$3" status
  status="$(v3 POST /orders "$body")"
  py order "$work/body" "$expect" "$label" "$status"
}

# B0 is the connector's body today; B1 leaves the line's totals to
# WooCommerce; B2a and B2b send ex-tax totals the connector would compute, at
# two and at six decimals.
body() { py body "$1" "$2" "${3:-}" "${4:-}"; }

# The downloads' prices as WooCommerce writes an order total (macOS ships bash
# 3.2, which has no associative arrays).
price_of() {
  case "$1" in
    20) echo 1.00 ;; 21) echo 2.00 ;; 23) echo 0.99 ;; 29) echo 1.03 ;; 30) echo 1.06 ;;
    24) echo 4.55 ;; 25) echo 9.99 ;; 26) echo 19.95 ;; 27) echo 33.33 ;; 28) echo 99.99 ;;
  esac
}
DOWNLOADS=(20 21 23 29 30 24 25 26 27 28)
TOTE=22
TOTE_PRICES=(20.00 0.99 19.95 33.33)

downloads() {
  local rate="$1" bodies="$2" id p
  for id in "${DOWNLOADS[@]}"; do
    p="$(price_of "$id")"
    echo " download $id at $p"
    if [[ "$bodies" == *B0* ]]; then order "B0" "$p" "$(body B0 "$id" "$p")"; fi
    if [[ "$bodies" == *B1* ]]; then order "B1" "$p" "$(body B1 "$id")"; fi
    if [[ "$bodies" == *B2* ]]; then
      order "B2a" "$p" "$(body B2a "$id" "$(py ex-tax "$p" "$rate" 0.01)")"
      order "B2b" "$p" "$(body B2b "$id" "$(py ex-tax "$p" "$rate" 0.000001)")"
    fi
    if [[ "$bodies" == *cart* ]]; then cart "$id"; fi
  done
}

# The tote bag at each price at one locality: the cart's quote, then the
# connector's body today and B1, each with the cheapest rate and the address.
parcels() {
  local country="$1" state="$2" city="$3" postcode="$4" locality p quoted rate lines today
  locality="{\"country\":\"$country\",\"state\":\"$state\",\"city\":\"$city\",\"postcode\":\"$postcode\"}"
  for p in "${TOTE_PRICES[@]}"; do
    v3 PUT "/products/$TOTE" "{\"regular_price\":\"$p\"}" >/dev/null
    echo " parcel at $p to $country $state $city $postcode"
    cart "$TOTE" "$locality"
    rate="$(py field "$work/cart" rate)"
    if [[ "$rate" == null ]]; then
      echo "  no rate"
      continue
    fi
    quoted="$(py field "$work/cart" total)"
    lines="$(py parcel-lines "$rate" "$country" "$state" "$city" "$postcode")"
    today="$(py goods-and-rate "$p" "$rate")"
    order "B0 against goods + rate" "$today" "$(body B0 "$TOTE" "$p" "$lines")"
    order "B1 against the cart's total_price" "$quoted" "$(body B1 "$TOTE" "" "$lines")"
  done
  v3 PUT "/products/$TOTE" '{"regular_price":"20.00"}' >/dev/null
}

# Q4 and Q6: which location a download order is taxed at, with no address and
# with a billing address, under each "Calculate tax based on" setting.
locations() {
  local id="$1" country="$2" state="$3" postcode="$4" city="$5" based billing
  billing="{\"billing\":{\"email\":\"merchant@example.com\",\"country\":\"$country\",\"state\":\"$state\",\"postcode\":\"$postcode\",\"city\":\"$city\"}}"
  for based in shipping billing base; do
    option woocommerce_tax_based_on "$based"
    order "B1, no address" "$(price_of "$id")" "$(body B1 "$id")"
    order "B1, billing $country" "$(price_of "$id")" "$(body B1 "$id" "" "$billing")"
  done
  option woocommerce_tax_based_on shipping
}

echo "run at $(date -u +%Y-%m-%dT%H:%M:%SZ) against a local WooCommerce shop"
wpcli plugin get woocommerce --field=version | sed 's/^/WooCommerce /'

mode off none
echo "== negative control: tax off, the connector's body today"
order "B0" "1.00" "$(body B0 20 1.00)"
cart 20

mode id none
echo "== Q1 Indonesia, prices include tax, display incl"
prices 20 "read without a cart token"
option woocommerce_tax_display_shop excl
prices 20 "with display excl"
option woocommerce_tax_display_shop incl
cart 20 '{"country":"US","state":"CA","city":"San Francisco","postcode":"94105"}'
prices 20 "with a cart token placed in San Francisco" "$cart_token"
echo "== Q2/Q3 Indonesia downloads, round at subtotal no"
downloads 11 "B0 B1 B2 cart"
option woocommerce_tax_round_at_subtotal yes
echo "== Q3 Indonesia downloads, round at subtotal yes"
downloads 11 "B0 B1 B2 cart"
option woocommerce_tax_round_at_subtotal no
echo "== Q4 Indonesia, which location a download is taxed at"
locations 20 US CA 94105 "San Francisco"
echo "== Q2/Q4 Indonesia parcels, shipping untaxed"
parcels ID BA Denpasar 80361
parcels ID JK Jakarta 10110
parcels US CA "San Francisco" 94105

mode id taxable
echo "== Q2/Q4 Indonesia parcels, shipping taxable"
parcels ID BA Denpasar 80361
parcels ID JK Jakarta 10110
parcels US CA "San Francisco" 94105

mode de taxable
echo "== Q1 Germany, prices include tax, display incl"
prices 20 "read without a cart token"
cart 20 '{"country":"FR","state":"","city":"Paris","postcode":"75001"}'
prices 20 "with a cart token placed in Paris" "$cart_token"
echo "== Q2/Q3 Germany downloads, round at subtotal no"
downloads 19 "B0 B1 B2 cart"
option woocommerce_tax_round_at_subtotal yes
echo "== Q3 Germany downloads, round at subtotal yes"
downloads 19 "B0 B1 B2 cart"
option woocommerce_tax_round_at_subtotal no
echo "== Q4 Germany, which location a download is taxed at"
locations 20 FR "" 75001 Paris
echo "== Q2/Q4 Germany parcels, shipping taxable"
parcels DE "" Berlin 10115
parcels FR "" Paris 75001

mode de taxable flat
echo "== Q4 Germany with the same gross price for every buyer"
cart 20 '{"country":"FR","state":"","city":"Paris","postcode":"75001"}'
prices 20 "with a cart token placed in Paris" "$cart_token"
order "B1, billing FR" "1.00" "$(body B1 20 "" '{"billing":{"email":"merchant@example.com","country":"FR","postcode":"75001","city":"Paris"}}')"
parcels FR "" Paris 75001

mode us taxable
echo "== Q1 Seattle, prices exclude tax, display excl"
prices 20 "read without a cart token"
option woocommerce_tax_display_shop incl
prices 20 "with display incl"
cart 20 '{"country":"US","state":"CA","city":"San Francisco","postcode":"94105"}'
prices 20 "with display incl and a cart token placed in San Francisco" "$cart_token"
option woocommerce_tax_display_shop excl
echo "== Q2/Q6 Seattle downloads, round at subtotal no"
downloads 0 "B0 B1 cart"
option woocommerce_tax_round_at_subtotal yes
echo "== Q6 Seattle downloads, round at subtotal yes"
downloads 0 "B1 cart"
option woocommerce_tax_round_at_subtotal no
echo "== Q6 Seattle, which location a download is taxed at"
locations 20 US CA 94105 "San Francisco"
echo "== Q5 Seattle parcels, shipping taxable"
parcels US WA Seattle 98101
parcels US CA "San Francisco" 94105

mode us none
echo "== Q5 Seattle parcels, shipping untaxed"
parcels US WA Seattle 98101

mode off none
