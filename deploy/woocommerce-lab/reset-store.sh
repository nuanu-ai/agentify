#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"

expected_root=/home/dmitry/.codex-project-storage/woocommerce-lab
env_file=.env

if [[ ! -f "$env_file" ]]; then
  umask 077
  admin_password="$(openssl rand -base64 24 | tr -d '\n')"
  db_password="$(openssl rand -hex 24)"
  root_password="$(openssl rand -hex 24)"
  {
    printf 'WOOCOMMERCE_DATA_ROOT=%s\n' "$expected_root"
    printf 'WORDPRESS_DB_PASSWORD=%s\n' "$db_password"
    printf 'MARIADB_ROOT_PASSWORD=%s\n' "$root_password"
    printf 'WORDPRESS_ADMIN_PASSWORD=%s\n' "$admin_password"
  } >"$env_file"
fi

set -a
# shellcheck disable=SC1091
source "$env_file"
set +a

resolved_root="$(realpath -m -- "$WOOCOMMERCE_DATA_ROOT")"
[[ "$resolved_root" == "$expected_root" ]] || {
  printf 'Refusing to reset unexpected data root: %s\n' "$resolved_root" >&2
  exit 2
}

docker_cmd=(sudo -n docker)
compose() { "${docker_cmd[@]}" compose "$@"; }
wp() { compose run --rm -T cli wp "$@"; }

printf 'Stopping the WooCommerce lab and deleting only %s data...\n' "$resolved_root"
compose down --remove-orphans

sudo -n install -d -m 0755 "$resolved_root"
for directory in db wordpress caddy-data caddy-config; do
  target="$resolved_root/$directory"
  sudo -n install -d -m 0755 "$target"
  sudo -n find "$target" -depth -mindepth 1 -delete
done
sudo -n chown 999:999 "$resolved_root/db"
sudo -n chown 33:33 "$resolved_root/wordpress"
sudo -n chown 1000:1000 "$resolved_root/caddy-data" "$resolved_root/caddy-config"

printf 'Starting WordPress, MariaDB and the HTTPS edge...\n'
compose up -d db wordpress caddy

for attempt in $(seq 1 90); do
  if compose exec -T wordpress test -f /var/www/html/wp-settings.php 2>/dev/null &&
    compose exec -T wordpress curl -fsS -o /dev/null http://localhost/ 2>/dev/null; then
    break
  fi
  if [[ "$attempt" == 90 ]]; then
    printf 'WordPress did not become ready.\n' >&2
    compose ps
    exit 1
  fi
  sleep 2
done

printf 'Installing WordPress and WooCommerce...\n'
wp core install \
  --url=https://woo.nuanu.ai \
  --title='Nuanu Digital Gifts — Test Store' \
  --admin_user=admin \
  --admin_password="$WORDPRESS_ADMIN_PASSWORD" \
  --admin_email=admin@woo.nuanu.ai \
  --skip-email
wp rewrite structure '/%postname%/' --hard
wp plugin install woocommerce --activate
wp rewrite flush --hard

printf 'Configuring the storefront and seeding products...\n'
wp option update woocommerce_currency USD
wp option update woocommerce_default_country 'US:CA'
wp option update woocommerce_store_address '1 Digital Market Street'
wp option update woocommerce_store_city 'San Francisco'
wp option update woocommerce_store_postcode '94105'
wp option update woocommerce_calc_taxes no
wp option update woocommerce_onboarding_profile '{"skipped":true}' --format=json
wp option update woocommerce_task_list_hidden yes || true
wp option update woocommerce_bacs_settings '{"enabled":"no"}' --format=json
wp option update woocommerce_cheque_settings '{"enabled":"no"}' --format=json
wp option update woocommerce_cod_settings '{"enabled":"no"}' --format=json
wp option update woocommerce_paypal_settings '{"enabled":"no"}' --format=json
wp option delete _transient__wc_activation_redirect 2>/dev/null || true
wp theme install storefront --activate
wp eval-file /seed/store.php
wp rewrite flush --hard

printf '\nWooCommerce lab is ready.\n'
printf 'Store:    https://woo.nuanu.ai\n'
printf 'Admin:    https://woo.nuanu.ai/wp-admin\n'
printf 'Username: admin\n'
printf 'Password: %s\n' "$WORDPRESS_ADMIN_PASSWORD"
printf '\nRun this same command after experiments to erase orders, API keys and changes:\n'
printf '  %s/reset-store.sh\n' "$(pwd)"

