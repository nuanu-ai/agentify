#!/usr/bin/env bash
#
# Brings the stand up and puts a WooCommerce shop on it. WP-CLI only: no
# browser wizard, no manual step, and running it twice is the same as running
# it once.
#
# Usage: ./setup.sh            bring up and configure
#        ./setup.sh --reset    destroy the volumes first, then do that
set -euo pipefail

cd "$(dirname "$0")"
HERE="$(pwd)"

SHOP_URL="http://localhost:8088"
ADMIN_USER="admin"
ADMIN_PASS="agentify-dev-admin"   # local stand only; see README
ADMIN_EMAIL="admin@example.test"

say() { printf '\n=== %s\n' "$*"; }

compose() { docker compose "$@"; }
wp() { docker compose run --rm -T cli wp "$@"; }

if [[ "${1:-}" == "--reset" ]]; then
  say "tearing the stand down, volumes included"
  compose down -v --remove-orphans || true
  rm -rf "${HERE}/var"
fi

say "preparing working directories"
mkdir -p "${HERE}/var/probe" "${HERE}/var/callback" "${HERE}/var/certs"
chmod 777 "${HERE}/var/probe" "${HERE}/var/callback"

# Two self-signed certificates, generated here and never committed. Both are
# needed for structural reasons, not for secrecy: WooCommerce refuses a
# plain-http callback_url, and its REST layer only accepts HTTP Basic when the
# request arrived over TLS.
mint_cert() {
  local name="$1" cn="$2" sans="$3"
  if [[ -f "${HERE}/var/certs/${name}-cert.pem" ]]; then return 0; fi
  say "minting a self-signed certificate for ${name} (CN=${cn})"
  openssl req -x509 -newkey rsa:2048 -nodes \
    -keyout "${HERE}/var/certs/${name}-key.pem" \
    -out "${HERE}/var/certs/${name}-cert.pem" \
    -days 7 -subj "/CN=${cn}" -addext "subjectAltName=${sans}" 2>/dev/null
  chmod 644 "${HERE}/var/certs/${name}-key.pem" "${HERE}/var/certs/${name}-cert.pem"
}

mint_cert callback callback "DNS:callback,DNS:localhost,IP:127.0.0.1"
mint_cert shop localhost "DNS:localhost,DNS:wordpress,IP:127.0.0.1"

say "starting containers"
compose up -d db wordpress callback

say "waiting for the WordPress document root to be populated"
for _ in $(seq 1 60); do
  if compose exec -T wordpress test -f /var/www/html/wp-settings.php 2>/dev/null; then
    break
  fi
  sleep 2
done
compose exec -T wordpress test -f /var/www/html/wp-settings.php

say "waiting for the shop to answer"
for _ in $(seq 1 60); do
  if curl -fsS -o /dev/null "${SHOP_URL}/" 2>/dev/null; then break; fi
  sleep 2
done

if ! wp core is-installed 2>/dev/null; then
  say "installing WordPress"
  wp core install \
    --url="${SHOP_URL}" \
    --title="Agentify WooCommerce probe stand" \
    --admin_user="${ADMIN_USER}" \
    --admin_password="${ADMIN_PASS}" \
    --admin_email="${ADMIN_EMAIL}" \
    --skip-email
else
  say "WordPress is already installed"
fi

say "pretty permalinks (wc-auth is a rewrite endpoint and 404s without them)"
wp rewrite structure '/%postname%/' --hard
wp rewrite flush --hard

if ! wp plugin is-installed woocommerce 2>/dev/null; then
  say "installing WooCommerce"
  wp plugin install woocommerce --activate
else
  say "WooCommerce is already installed"
  wp plugin activate woocommerce || true
fi
wp rewrite flush --hard

say "store settings"
wp option update woocommerce_currency USD
wp option update woocommerce_default_country 'US:CA'
wp option update woocommerce_store_address '1 Probe Street'
wp option update woocommerce_store_city 'San Francisco'
wp option update woocommerce_store_postcode '94110'
wp option update woocommerce_calc_taxes no
# Keep the onboarding wizard from hijacking the admin screens; the probes drive
# the shop through the API, but a human opening wp-admin should land on the
# dashboard, not a funnel.
wp option update woocommerce_onboarding_profile '{"skipped":true}' --format=json
# Not present on every WooCommerce release; its absence changes nothing the
# probes look at.
wp option update woocommerce_task_list_hidden yes || true
wp option delete _transient__wc_activation_redirect 2>/dev/null || true

say "seeding products"
existing_skus="$(wp wc product list --user="${ADMIN_USER}" --per_page=100 --field=sku --format=csv 2>/dev/null || true)"

have_sku() { printf '%s\n' "${existing_skus}" | grep -qx "$1"; }

LONG_RU_DESC="Абонемент даёт право посещать территорию в течение календарного месяца с момента активации кода. Код приходит на указанную почту сразу после оплаты и активируется при первом проходе через турникет: с этого момента отсчитываются тридцать дней. Абонемент именной, передавать его третьим лицам нельзя, при входе может потребоваться документ. В стоимость входит доступ ко всем открытым площадкам, к зонам отдыха и к бесплатным мероприятиям расписания; отдельные мастер-классы, аренда оборудования и экскурсии с гидом оплачиваются отдельно по действующему прейскуранту. Возврат возможен, пока код не активирован; после первого прохода стоимость не возвращается и срок не продлевается, кроме случаев, когда территория закрыта по решению администрации. Часы работы и список открытых площадок публикуются на сайте и могут меняться в зависимости от сезона и погоды."

if have_sku "agentify-access-code"; then
  echo "  agentify-access-code already present"
else
  wp wc product create --user="${ADMIN_USER}" \
    --name="Access code" \
    --type=simple \
    --virtual=true \
    --downloadable=false \
    --sku="agentify-access-code" \
    --regular_price="5.00" \
    --status=publish \
    --description="A single-use access code delivered by email." \
    --short_description="Digital access code." \
    --porcelain
fi

if have_sku "agentify-tote"; then
  echo "  agentify-tote already present"
else
  wp wc product create --user="${ADMIN_USER}" \
    --name="Canvas tote bag" \
    --type=simple \
    --virtual=false \
    --sku="agentify-tote" \
    --regular_price="25.00" \
    --weight="0.3" \
    --manage_stock=true \
    --stock_quantity=10 \
    --status=publish \
    --description="A physical item that has to be shipped somewhere." \
    --short_description="Physical goods, shipped." \
    --porcelain
fi

if have_sku "agentify-abonement"; then
  echo "  agentify-abonement already present"
else
  wp wc product create --user="${ADMIN_USER}" \
    --name="Абонемент на месяц" \
    --type=simple \
    --virtual=true \
    --sku="agentify-abonement" \
    --regular_price="120.00" \
    --status=publish \
    --description="${LONG_RU_DESC}" \
    --short_description="Месячный абонемент на посещение территории." \
    --porcelain
fi

say "what the stand is running"
wp core version --extra | sed 's/^/  /'
wp plugin list --status=active --fields=name,version --format=table | sed 's/^/  /'
wp wc product list --user="${ADMIN_USER}" --fields=id,sku,name,type,virtual,price --format=table | sed 's/^/  /'

cat <<EOF

Stand is up.
  shop       ${SHOP_URL}
  wp-admin   ${SHOP_URL}/wp-admin  (${ADMIN_USER} / ${ADMIN_PASS})
  callback   https://localhost:8099/health  (self-signed)

Run ./probe.mjs next.
EOF
