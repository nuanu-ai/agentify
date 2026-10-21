#!/usr/bin/env bash
# Builds the throwaway shop of docs/research/56-woo-tax-probe.md on this
# machine: WordPress and WooCommerce as the integration lab's baseline installs
# them, seeded with the lab's own store.php and parcel.php, the probe's
# awkward prices added, and one read/write REST key.
#
# Passwords and the key are generated per run and written only to the state
# directory named by PROBE_STATE, which must lie outside the repository:
#
#   PROBE_STATE=/some/private/dir ./setup.sh
#
# `docker compose -p woo-tax-probe down -v` removes the shop and its volumes.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
: "${PROBE_STATE:?set PROBE_STATE to a private directory outside the repository}"
mkdir -p "$PROBE_STATE"
env_file="$PROBE_STATE/env"
port="${PROBE_PORT:-18456}"

if [[ ! -f "$env_file" ]]; then
  umask 077
  {
    printf 'PROBE_PORT=%s\n' "$port"
    printf 'WORDPRESS_DB_PASSWORD=%s\n' "$(openssl rand -hex 24)"
    printf 'MARIADB_ROOT_PASSWORD=%s\n' "$(openssl rand -hex 24)"
    printf 'WORDPRESS_ADMIN_PASSWORD=%s\n' "$(openssl rand -hex 24)"
  } >"$env_file"
fi
set -a
# shellcheck disable=SC1090
source "$env_file"
set +a

compose() { docker compose --env-file "$env_file" "$@"; }
wp() { compose run --rm -T cli wp "$@"; }

compose up -d db wordpress
for _ in $(seq 1 90); do
  if compose exec -T wordpress curl -fsS -o /dev/null http://localhost/wp-admin/install.php 2>/dev/null; then
    break
  fi
  sleep 1
done

wp core install \
  --url="http://localhost:$port" \
  --title='Test Gift Shop' \
  --admin_user=admin \
  --admin_password="$WORDPRESS_ADMIN_PASSWORD" \
  --admin_email=admin@example.com \
  --skip-email
wp rewrite structure '/%postname%/' --hard
wp plugin install woocommerce --activate
wp rewrite flush --hard

# The lab's own baseline settings, as its reset-store.sh writes them.
wp option update woocommerce_default_country 'US:CA'
wp option update woocommerce_store_address '1 Digital Market Street'
wp option update woocommerce_store_city 'San Francisco'
wp option update woocommerce_store_postcode '94105'
wp option update woocommerce_onboarding_profile '{"skipped":true}' --format=json
wp option update woocommerce_task_list_hidden yes || true
wp option update woocommerce_bacs_settings '{"enabled":"no"}' --format=json
wp option update woocommerce_cheque_settings '{"enabled":"no"}' --format=json
wp option update woocommerce_cod_settings '{"enabled":"no"}' --format=json
wp option update woocommerce_paypal_settings '{"enabled":"no"}' --format=json
wp theme install storefront --activate
wp eval-file /seed/store.php
wp eval-file /seed/parcel.php
wp eval-file /probe/awkward.php
wp rewrite flush --hard

key="$(wp eval-file /probe/key.php)"
{
  printf 'WOO_KEY=%s\n' "${key%% *}"
  printf 'WOO_SECRET=%s\n' "${key##* }"
} >>"$env_file"

wp core version --extra
wp plugin list --fields=name,version,status
wp wc product list --user=admin --fields=id,name,regular_price,virtual,downloadable --per_page=50
