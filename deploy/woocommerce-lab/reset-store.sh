#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"

env_file=.env
mode="${1:-restore}"

if [[ "$mode" != restore && "$mode" != --rebuild-baseline ]]; then
  printf 'Usage: %s [--rebuild-baseline]\n' "$0" >&2
  exit 2
fi

if [[ -f "$env_file" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$env_file"
  set +a
fi

# Where the shop listens and where its data and baseline live are deployment
# facts. Existing installations read them from the server-owned environment;
# first initialization requires them explicitly and persists both.
: "${WOOCOMMERCE_DATA_ROOT:?set WOOCOMMERCE_DATA_ROOT to the directory holding the lab data and baseline}"
: "${WOO_LAB_LISTEN_ADDRESS:?set WOO_LAB_LISTEN_ADDRESS to the address the lab Caddy binds on}"
expected_root="$WOOCOMMERCE_DATA_ROOT"

if [[ ! -f "$env_file" ]]; then
  if [[ -e "$expected_root/baseline/wordpress.sql.gz" ||
    -e "$expected_root/baseline/wordpress.tar.gz" ]]; then
    printf 'Refusing to create new credentials for an existing baseline. Restore the server-owned .env first.\n' >&2
    exit 1
  fi
  umask 077
  admin_password="$(openssl rand -base64 24 | tr -d '\n')"
  db_password="$(openssl rand -hex 24)"
  root_password="$(openssl rand -hex 24)"
  {
    printf 'WOOCOMMERCE_DATA_ROOT=%s\n' "$expected_root"
    printf 'WOO_LAB_LISTEN_ADDRESS=%s\n' "$WOO_LAB_LISTEN_ADDRESS"
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

baseline="$resolved_root/baseline"
database_baseline="$baseline/wordpress.sql.gz"
wordpress_baseline="$baseline/wordpress.tar.gz"
docker_cmd=(sudo -n docker)
compose() { "${docker_cmd[@]}" compose "$@"; }
wp() { compose run --rm -T cli wp "$@"; }

clear_shop_data() {
  compose down --remove-orphans
  sudo -n install -d -m 0755 "$resolved_root" "$baseline"
  sudo -n chown "$(id -u):$(id -g)" "$baseline"
  for directory in db wordpress; do
    target="$resolved_root/$directory"
    sudo -n install -d -m 0755 "$target"
    sudo -n find "$target" -depth -mindepth 1 -delete
  done
  sudo -n install -d -m 0755 "$resolved_root/caddy-data" "$resolved_root/caddy-config"
  sudo -n chown 999:999 "$resolved_root/db"
  sudo -n chown 33:33 "$resolved_root/wordpress"
  sudo -n chown 1000:1000 "$resolved_root/caddy-data" "$resolved_root/caddy-config"
}

wait_for_database() {
  for attempt in $(seq 1 60); do
    if compose exec -T db healthcheck.sh --connect --innodb_initialized >/dev/null 2>&1; then
      return
    fi
    sleep 1
  done
  printf 'MariaDB did not become ready.\n' >&2
  compose ps
  exit 1
}

wait_for_wordpress() {
  for attempt in $(seq 1 90); do
    if compose exec -T wordpress test -f /var/www/html/wp-settings.php 2>/dev/null &&
      compose exec -T wordpress curl -fsS -o /dev/null http://localhost/ 2>/dev/null; then
      return
    fi
    sleep 1
  done
  printf 'WordPress did not become ready.\n' >&2
  compose ps
  exit 1
}

capture_baseline() {
  database_tmp="$database_baseline.tmp"
  wordpress_tmp="$wordpress_baseline.tmp"
  rm -f "$database_tmp" "$wordpress_tmp"
  compose exec -T -e MYSQL_PWD="$MARIADB_ROOT_PASSWORD" db mariadb-dump \
    -uroot --single-transaction --routines --events --triggers wordpress |
    gzip -1 >"$database_tmp"
  sudo -n tar --numeric-owner -C "$resolved_root/wordpress" -cf - . |
    gzip -1 >"$wordpress_tmp"
  mv "$database_tmp" "$database_baseline"
  mv "$wordpress_tmp" "$wordpress_baseline"
}

build_baseline() {
  printf 'Building the local WooCommerce baseline...\n'
  clear_shop_data
  compose up -d db wordpress caddy
  wait_for_database
  wait_for_wordpress

  wp core install \
    --url=https://woo.nuanu.ai \
    --title='Test Gift Shop' \
    --admin_user=admin \
    --admin_password="$WORDPRESS_ADMIN_PASSWORD" \
    --admin_email=admin@woo.nuanu.ai \
    --skip-email
  wp rewrite structure '/%postname%/' --hard
  wp plugin install woocommerce --activate
  wp rewrite flush --hard

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
  wp option delete _transient__wc_activation_redirect 2>/dev/null || true
  wp theme install storefront --activate
  wp eval-file /seed/store.php
  wp rewrite flush --hard
  capture_baseline
  printf 'Local baseline captured.\n'
}

restore_baseline() {
  [[ -s "$database_baseline" && -s "$wordpress_baseline" ]] || {
    printf 'Local baseline is missing. Build it once with:\n  %s/reset-store.sh --rebuild-baseline\n' "$(pwd)" >&2
    exit 1
  }
  gzip -t "$database_baseline" || {
    printf 'Database baseline is corrupt; the running shop was not changed.\n' >&2
    exit 1
  }
  gzip -t "$wordpress_baseline" || {
    printf 'WordPress baseline is corrupt; the running shop was not changed.\n' >&2
    exit 1
  }
  tar -tzf "$wordpress_baseline" >/dev/null || {
    printf 'WordPress baseline is not a readable archive; the running shop was not changed.\n' >&2
    exit 1
  }

  printf 'Restoring the WooCommerce lab from the local baseline...\n'
  clear_shop_data
  sudo -n tar -xzf "$wordpress_baseline" -C "$resolved_root/wordpress"
  sudo -n chown -R 33:33 "$resolved_root/wordpress"

  compose up -d db
  wait_for_database
  gzip -dc "$database_baseline" | compose exec -T \
    -e MYSQL_PWD="$MARIADB_ROOT_PASSWORD" db mariadb -uroot wordpress
  compose up -d wordpress caddy
  wait_for_wordpress
  printf '%s\n' "$WORDPRESS_ADMIN_PASSWORD" | \
    compose run --rm -T cli wp user update admin --prompt=user_pass --skip-email >/dev/null
}

if [[ "$mode" == --rebuild-baseline ]]; then
  build_baseline
else
  restore_baseline
fi

printf '\nWooCommerce lab is ready.\n'
printf 'Store:    https://woo.nuanu.ai\n'
printf 'Admin:    https://woo.nuanu.ai/wp-admin\n'
printf 'Username: admin\n'
printf 'Password: %s\n' "$WORDPRESS_ADMIN_PASSWORD"
printf '\nRun this same command after experiments to erase orders, API keys and changes:\n'
printf '  %s/reset-store.sh\n' "$(pwd)"
