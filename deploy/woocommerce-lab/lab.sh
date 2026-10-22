#!/usr/bin/env bash
# The scripts handed to in_lab and wp eval are single-quoted on purpose: they
# expand inside the container, not here.
# shellcheck disable=SC2016

# The WooCommerce lab's one command: it builds the shop profiles, switches the
# running shop between them, lays overlays over the active one, and keeps the
# two instruments, settings readings and the request log. README.md describes
# each profile and overlay and what a switch does to a connected merchant.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"
lab_dir="$(pwd)"

PROFILES="basic realistic realistic-usd hard"
OVERLAYS="tax-incl tax-excl tax-per-line tax-shop-shows-excl tax-cart-shows-excl tax-on-billing tax-on-base over-limit"

usage() {
  cat <<'EOF'
Usage: ./lab.sh <command>

  status                      which profile and overlays the shop runs, whether
                              Agentify's REST keys exist, how big the request log is
  list                        the stored profiles: when and from what each was built
  switch <profile>            restore a stored profile, offline, and check it
  overlay <overlay>           lay an overlay over the active profile and check it
  check [--as <profile>]      check the shop against its profile and overlays,
                              or against another profile
  build <profile>|all         build a profile from the baseline and store it
                              (realistic and hard download their plugins)
  baseline                    rebuild the clean baseline every profile starts from
                              (downloads WordPress and WooCommerce)
  settings save <name>        take a settings reading
  settings diff <a> <b>       show every difference between two readings
  settings list               the readings taken
  requests [--since WHEN] [--until WHEN] [--agent TEXT]
                              the requests the shop received, as its Caddy logged them
  orders [AGENTIFY_ORDER_ID]  how many orders the shop holds, by status, and every
                              order carrying that Agentify order; exits 3 if none does

Profiles: basic realistic realistic-usd hard
Overlays: tax-incl tax-excl tax-per-line tax-shop-shows-excl tax-cart-shows-excl
          tax-on-billing tax-on-base over-limit
EOF
}

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}

one_of() {
  local word="$1" list="$2" item
  for item in $list; do
    [[ "$word" == "$item" ]] && return 0
  done
  return 1
}

load_env() {
  if [[ -f .env ]]; then
    set -a
    # shellcheck disable=SC1091
    source .env
    set +a
  elif [[ "${1:-}" != first-run ]]; then
    fail "the lab's .env is missing. A new lab starts with: WOOCOMMERCE_DATA_ROOT=... WOO_LAB_LISTEN_ADDRESS=... ./lab.sh baseline"
  fi
  # Where the shop listens and where its data lives are deployment facts.
  : "${WOOCOMMERCE_DATA_ROOT:?set WOOCOMMERCE_DATA_ROOT to the directory holding the lab data, baseline and profiles}"
  : "${WOO_LAB_LISTEN_ADDRESS:?set WOO_LAB_LISTEN_ADDRESS to the address the lab Caddy binds on}"
  # A copy at its own address that is not wired to the controlled Woo fault
  # would run the lab's own Caddy and address over it, both of which lead to
  # the shared lab.
  if [[ -n "${WOO_LAB_URL:-}" && ":${COMPOSE_FILE:-}:" != *":local-copy.yaml:"* ]]; then
    fail "WOO_LAB_URL names a local copy, and COMPOSE_FILE does not lay local-copy.yaml over compose.yaml; the copy's .env sets COMPOSE_FILE=compose.yaml:local-copy.yaml"
  fi
  local resolved
  resolved="$(python3 -I -c 'import os, sys; print(os.path.realpath(sys.argv[1]))' "$WOOCOMMERCE_DATA_ROOT")"
  [[ "$resolved" == "$WOOCOMMERCE_DATA_ROOT" ]] ||
    fail "WOOCOMMERCE_DATA_ROOT must be an absolute path without links; it resolves to $resolved"
  root="$resolved"
}

# Docker is called directly where this user may, and through sudo where the
# host keeps it for root, as the fixture host does.
if docker info >/dev/null 2>&1; then
  docker_cmd=(docker)
else
  docker_cmd=(sudo -n docker)
fi
compose() { "${docker_cmd[@]}" compose "$@"; }
# Without --no-deps a call would start the database on whatever files are in
# place, even half way through another command's switch.
wp() { compose run --rm --no-deps -T cli wp "$@"; }
# A shell script run as root against the data directory, mounted at /lab.
in_lab() {
  local script="$1"
  shift
  compose run --rm --no-deps -T tools "$script" lab "$@"
}

# A command that changes the shop writes what it is doing to /lab/unfinished
# first and removes it once the shop has passed its check, so that an
# interruption at any step leaves a sentence for status and a refusal for
# check and overlay, rather than a shop that looks like a profile it is not.
mark_unfinished() {
  in_lab 'printf "%s|%s|%s\n" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1" "$2" >/lab/unfinished; rm -f /lab/active' "$1" "$2"
}

finished_as() {
  in_lab 'echo "$*" >/lab/active; rm -f /lab/unfinished' "$@"
}

# One command at a time: two switches, or a reading during a switch, would
# move the database's files under each other.
take_lock() {
  local lock="$lab_dir/.lab.lock"
  if ! mkdir "$lock" 2>/dev/null; then
    if lock_held "$lock"; then
      fail "another ./lab.sh command is running ($(cat "$lock/command" 2>/dev/null || echo 'starting')). If none is, remove $lock"
    fi
    # Moved aside before it is removed, so that of two commands taking over
    # the same stale lock only one can.
    mv "$lock" "$lock.stale.$$" 2>/dev/null && rm -rf "$lock.stale.$$"
    mkdir "$lock" 2>/dev/null || fail "another ./lab.sh command took the lab's lock at $lock first"
  fi
  echo $$ >"$lock/pid"
  echo "$*" >"$lock/command"
  lab_lock="$lock"
}

# A lock is held while the process that took it is a lab.sh, or while it is
# too new to have written its process number.
lock_held() {
  local holder
  holder="$(cat "$1/pid" 2>/dev/null || true)"
  [[ -z "$holder" ]] && return 0
  ps -p "$holder" -o command= 2>/dev/null | grep -q 'lab\.sh'
}

lab_busy() {
  [[ -d "$lab_dir/.lab.lock" ]] && lock_held "$lab_dir/.lab.lock"
}

seconds() { python3 -I -c 'import time; print(f"{time.time():.1f}")'; }
since() { python3 -I -c 'import sys, time; print(f"{time.time() - float(sys.argv[1]):.1f}")' "$1"; }

# A build restores the baseline from its SQL dump, so MariaDB first creates its
# data directory from nothing; on the fixture host that took three minutes
# where a laptop took seconds.
wait_for_database() {
  for _ in $(seq 1 600); do
    if compose exec -T db healthcheck.sh --connect --innodb_initialized >/dev/null 2>&1; then
      return
    fi
    sleep 1
  done
  compose ps
  fail "MariaDB did not become ready"
}

wait_for_wordpress() {
  for _ in $(seq 1 120); do
    if compose exec -T wordpress curl -fsS -o /dev/null http://localhost/wp-login.php 2>/dev/null; then
      return
    fi
    sleep 1
  done
  compose ps
  fail "WordPress did not become ready"
}

# Starts the shop and waits for it by polling, rather than through Compose's
# health checks, which are polled every five seconds.
start_shop() {
  compose up -d --no-deps db
  wait_for_database
  compose up -d --no-deps wordpress
  wait_for_wordpress
  compose up -d --no-deps caddy
  if [[ "${1:-}" == with-mail ]]; then
    compose --profile realistic up -d --no-deps mailpit
  fi
}

set_admin_password() {
  printf '%s\n' "$WORDPRESS_ADMIN_PASSWORD" |
    wp user update admin --prompt=user_pass --skip-email >/dev/null
}

stop_shop() {
  compose --profile realistic stop -t 60 mailpit wordpress db >/dev/null 2>&1 ||
    compose stop -t 60 wordpress db
}

prepare_data_root() {
  in_lab 'mkdir -p /lab/baseline /lab/profiles /lab/readings /lab/db /lab/wordpress /lab/caddy-data /lab/caddy-config /lab/caddy-logs'
}

# The files a profile is built from. A stored profile records their
# fingerprint, so that status can say when the lab has changed since.
source_fingerprint() {
  python3 -I - "$lab_dir" <<'PY'
import hashlib, os, sys
root = sys.argv[1]
names = ["lab.sh", "compose.yaml", "apache-log.conf"]
for directory, _, files in os.walk(os.path.join(root, "seed")):
    names += [os.path.relpath(os.path.join(directory, f), root) for f in files]
digest = hashlib.sha256()
for name in sorted(names):
    digest.update(name.encode() + b"\0")
    with open(os.path.join(root, name), "rb") as handle:
        digest.update(hashlib.sha256(handle.read()).digest())
print(digest.hexdigest()[:16])
PY
}

database_image() {
  compose config --format json | python3 -I -c 'import json, sys; print(json.load(sys.stdin)["services"]["db"]["image"])'
}

# --- The baseline ------------------------------------------------------------

# Empties the shop and loads the baseline: a database dump and the WordPress
# files, from which every profile is built.
restore_baseline() {
  in_lab 'test -s /lab/baseline/wordpress.sql.gz && test -s /lab/baseline/wordpress.tar.gz' ||
    fail "the baseline is missing; build it once with ./lab.sh baseline"
  in_lab 'gzip -t /lab/baseline/wordpress.sql.gz && gzip -t /lab/baseline/wordpress.tar.gz' ||
    fail "the baseline is corrupt; the running shop was not changed"
  stop_shop
  in_lab 'mkdir -p /lab/db /lab/wordpress
    find /lab/db /lab/wordpress -mindepth 1 -delete
    tar -xzf /lab/baseline/wordpress.tar.gz -C /lab/wordpress
    chown -R 33:33 /lab/wordpress && chown 999:999 /lab/db'
  compose up -d db
  wait_for_database
  in_lab 'gzip -dc /lab/baseline/wordpress.sql.gz' |
    compose exec -T -e MYSQL_PWD="$MARIADB_ROOT_PASSWORD" db mariadb -uroot wordpress
  compose up -d --no-deps wordpress
  wait_for_wordpress
  compose up -d --no-deps caddy
  set_admin_password
}

build_baseline() {
  if [[ ! -f .env ]]; then
    load_env first-run
    if in_lab 'test -e /lab/baseline/wordpress.sql.gz || test -e /lab/baseline/wordpress.tar.gz'; then
      fail "refusing to create new credentials for an existing baseline; restore the server-owned .env first"
    fi
    (
      umask 077
      {
        printf 'WOOCOMMERCE_DATA_ROOT=%s\n' "$root"
        printf 'WOO_LAB_LISTEN_ADDRESS=%s\n' "$WOO_LAB_LISTEN_ADDRESS"
        printf 'WORDPRESS_DB_PASSWORD=%s\n' "$(openssl rand -hex 24)"
        printf 'MARIADB_ROOT_PASSWORD=%s\n' "$(openssl rand -hex 24)"
        printf 'WORDPRESS_ADMIN_PASSWORD=%s\n' "$(openssl rand -base64 24 | tr -d '\n')"
      } >.env
    )
  fi
  load_env
  printf 'Building the clean baseline, which downloads WordPress and WooCommerce...\n'
  prepare_data_root
  stop_shop
  mark_unfinished "a rebuild of the baseline" "./lab.sh switch basic"
  in_lab 'mkdir -p /lab/db /lab/wordpress
    find /lab/db /lab/wordpress -mindepth 1 -delete
    chown 33:33 /lab/wordpress && chown 999:999 /lab/db'
  compose up -d db wordpress caddy
  wait_for_database
  wait_for_wordpress

  # A local copy behind the controlled Woo fault names its own address in its
  # .env, so that every link its profiles store leads to the copy.
  wp core install \
    --url="${WOO_LAB_URL:-https://woo.nuanu.ai}" \
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

  compose exec -T -e MYSQL_PWD="$MARIADB_ROOT_PASSWORD" db mariadb-dump \
    -uroot --single-transaction --routines --events --triggers wordpress |
    gzip -1 | in_lab 'cat >/lab/baseline/wordpress.sql.gz.tmp'
  compose stop wordpress
  in_lab 'tar --numeric-owner -C /lab/wordpress -czf /lab/baseline/wordpress.tar.gz.tmp .
    mv /lab/baseline/wordpress.sql.gz.tmp /lab/baseline/wordpress.sql.gz
    mv /lab/baseline/wordpress.tar.gz.tmp /lab/baseline/wordpress.tar.gz'
  compose up -d wordpress
  in_lab 'rm -f /lab/unfinished /lab/active'
  printf 'The baseline is stored. Build the profiles from it with ./lab.sh build all\n'
}

# --- Profiles ----------------------------------------------------------------

lay_realistic() {
  local currency="$1" plugin
  # The seed runs first because it installs the hook that hands mail to the
  # catcher, and a plugin may send mail as it is activated.
  compose --profile realistic up -d mailpit
  wp eval-file /seed/realistic.php "$currency"
  # One slug@version a line, without spaces.
  # shellcheck disable=SC2013
  for plugin in $(grep -v '^#' seed/plugins.txt); do
    wp plugin install "${plugin%@*}" --version="${plugin#*@}" --force --activate
  done
}

has_mail_catcher() { [[ "$1" != basic ]]; }

run_check() {
  wp eval-file /seed/check.php "$@"
}

build_profile() {
  local profile="$1" started check_output
  started="$(seconds)"
  printf '\n== Building the %s profile from the baseline\n' "$profile"
  mark_unfinished "a build of the $profile profile" "./lab.sh build $profile, or switch to a stored profile"
  restore_baseline
  case "$profile" in
    basic) wp eval-file /seed/parcel.php ;;
    realistic) lay_realistic IDR ;;
    realistic-usd) lay_realistic USD ;;
    hard)
      lay_realistic IDR
      wp eval-file /seed/hard.php
      ;;
  esac
  wp option update agentify_lab_profile "$profile" >/dev/null
  wp option delete agentify_lab_overlays >/dev/null 2>&1 || true
  wp rewrite flush --hard
  if ! check_output="$(run_check "$profile" 2>&1)"; then
    printf '%s\n' "$check_output"
    fail "the $profile profile failed its own check and was not stored"
  fi
  printf '%s\n' "$check_output"

  # The database's own files are stored, not a dump, so that a switch restores
  # them in seconds; they are copied while the database is stopped.
  stop_shop
  in_lab 'd=/lab/profiles/.$1.new; rm -rf "$d"; mkdir -p "$d"
    tar --numeric-owner -C /lab/db -czf "$d/db.tar.gz" .
    tar --numeric-owner -C /lab/wordpress -czf "$d/wordpress.tar.gz" .
    stat -c "%s" "$d/db.tar.gz" "$d/wordpress.tar.gz"' "$profile" >"$lab_tmp/sizes"
  if has_mail_catcher "$profile"; then start_shop with-mail; else start_shop; fi

  local revision changed=no
  revision="$(git rev-parse --short=12 HEAD 2>/dev/null || head -c 12 "$lab_dir/REVISION" 2>/dev/null || echo 'not a git checkout')"
  if [[ -n "$(git status --porcelain -- . 2>/dev/null)" ]]; then
    changed=yes
  fi
  CHECK_OUTPUT="$check_output" python3 -I - "$profile" "$revision" "$changed" "$(source_fingerprint)" \
    "$(database_image)" "$(has_mail_catcher "$profile" && echo yes || echo no)" "$lab_tmp/sizes" "$(since "$started")" <<'PY' |
import json, os, sys
from datetime import datetime, timezone
profile, revision, changed, fingerprint, image, mail, sizes, took = sys.argv[1:]
db_size, wordpress_size = (int(line) for line in open(sizes).read().split())
print(json.dumps({
    "profile": profile,
    "built_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    "revision": revision,
    "uncommitted_lab_changes": changed == "yes",
    "lab_fingerprint": fingerprint,
    "database_image": image,
    "mail_catcher": mail == "yes",
    "build_seconds": float(took),
    "bytes": {"db.tar.gz": db_size, "wordpress.tar.gz": wordpress_size},
    "check": {"result": "passed", "output": os.environ["CHECK_OUTPUT"].splitlines()},
}, indent=2))
PY
    in_lab 'cat >"/lab/profiles/.$1.new/manifest.json"
      rm -rf "/lab/profiles/.$1.old"
      if [ -d "/lab/profiles/$1" ]; then mv "/lab/profiles/$1" "/lab/profiles/.$1.old"; fi
      mv "/lab/profiles/.$1.new" "/lab/profiles/$1"
      rm -rf "/lab/profiles/.$1.old"' "$profile"
  finished_as "$profile"
  printf 'The %s profile is stored (%ss) and is the running shop.\n' "$profile" "$(since "$started")"
}

read_manifest() {
  in_lab 'cat "/lab/profiles/$1/manifest.json"' "$1" 2>/dev/null
}

switch_profile() {
  local profile="$1" started manifest
  started="$(seconds)"
  manifest="$(read_manifest "$profile")" || fail "the $profile profile has not been built here; build it with ./lab.sh build $profile"
  MANIFEST="$manifest" python3 -I - "$(database_image)" <<'PY' || exit 1
import json, os, sys
manifest = json.loads(os.environ["MANIFEST"])
if manifest.get("check", {}).get("result") != "passed":
    raise SystemExit(f"FAIL: the stored {manifest.get('profile')} profile has no passed check; rebuild it")
if manifest.get("database_image") != sys.argv[1]:
    raise SystemExit(
        f"FAIL: the {manifest['profile']} profile holds files of {manifest.get('database_image')}, "
        f"and the lab now runs {sys.argv[1]}; rebuild the profile"
    )
PY
  # Everything that can fail without touching the running shop happens first:
  # the archives are tested and unpacked beside the live data.
  in_lab 'p="/lab/profiles/$1"
    gzip -t "$p/db.tar.gz"; gzip -t "$p/wordpress.tar.gz"
    rm -rf /lab/db.next /lab/wordpress.next; mkdir /lab/db.next /lab/wordpress.next
    tar -xzf "$p/db.tar.gz" -C /lab/db.next
    tar -xzf "$p/wordpress.tar.gz" -C /lab/wordpress.next' "$profile" ||
    fail "the stored $profile profile could not be unpacked; the running shop was not changed"

  # From here until the check passes, the shop is neither the old profile nor
  # the new one, and status says so.
  mark_unfinished "a switch to the $profile profile" "./lab.sh switch $profile"
  stop_shop
  in_lab 'rm -rf /lab/db.old /lab/wordpress.old
    [ ! -e /lab/db ] || mv /lab/db /lab/db.old
    mv /lab/db.next /lab/db
    [ ! -e /lab/wordpress ] || mv /lab/wordpress /lab/wordpress.old
    mv /lab/wordpress.next /lab/wordpress
    rm -rf /lab/db.old /lab/wordpress.old'
  if has_mail_catcher "$profile"; then start_shop with-mail; else start_shop; fi
  set_admin_password
  if ! run_check "$profile"; then
    fail "the shop restored from the $profile profile is not that profile; status reports an unfinished switch"
  fi
  finished_as "$profile"
  printf '\nThe shop is the %s profile, switched in %ss. Orders, customers, REST API keys and\n' "$profile" "$(since "$started")"
  printf 'any Agentify connection to the shop are gone: a connected merchant connects again.\n'
  printf 'Store: %s  Admin: admin, with the password in .env\n' "${WOO_LAB_URL:-https://woo.nuanu.ai}"
}

active_profile() {
  in_lab 'if test ! -e /lab/unfinished && test -e /lab/active; then cut -d" " -f1 /lab/active; fi' 2>/dev/null || true
}

lay_overlay() {
  local overlay="$1" started profile
  started="$(seconds)"
  profile="$(active_profile)"
  [[ -n "$profile" ]] || fail "no profile is active; switch to one first"
  local before
  before="$(recorded_overlays)"
  # The shop must be its profile before anything is laid over it, so that a
  # failure afterwards is the overlay's and a refusal here changes nothing.
  # shellcheck disable=SC2086
  run_check "$profile" $before >"$lab_tmp/before" 2>&1 || {
    grep -E '^(FAIL|Error)' "$lab_tmp/before" >&2 || true
    fail "the shop is not the $profile profile${before:+ with $before} as it stands, so nothing was laid over it; ./lab.sh switch $profile restores it"
  }
  mark_unfinished "the $overlay overlay laid over the $profile profile${before:+ with $before}" \
    "./lab.sh switch $profile, then lay the overlays again"
  wp eval-file /seed/overlay.php "$overlay"
  # shellcheck disable=SC2046
  run_check "$profile" $(recorded_overlays) || fail "the shop failed its check with $overlay laid over it; status reports it as unfinished"
  # shellcheck disable=SC2046
  finished_as "$profile" $(recorded_overlays)
  printf 'Overlay %s laid over the %s profile in %ss.\n' "$overlay" "$profile" "$(since "$started")"
}

# The overlays laid since the last switch, as the shop itself records them.
recorded_overlays() {
  { wp option get agentify_lab_overlays --format=json 2>/dev/null || echo '[]'; } |
    python3 -I -c 'import json, sys; print(" ".join(json.loads(sys.stdin.read() or "[]")))'
}

check_shop() {
  local as="" profile overlays
  if [[ "${1:-}" == --as ]]; then
    as="${2:?--as needs a profile}"
    one_of "$as" "$PROFILES" || fail "no profile is called $as"
  fi
  profile="$(active_profile)"
  [[ -n "$profile" ]] || fail "no profile is active; switch to one first"
  overlays="$(recorded_overlays)"
  # shellcheck disable=SC2086
  run_check "${as:-$profile}" $overlays
}

# --- Reports -----------------------------------------------------------------

show_status() {
  local unfinished active
  if lab_busy; then
    printf 'Busy:      ./lab.sh %s is running; what follows may change under it.\n' "$(cat "$lab_dir/.lab.lock/command" 2>/dev/null || echo '…')"
  fi
  unfinished="$(in_lab 'cat /lab/unfinished 2>/dev/null || true')"
  if [[ -n "$unfinished" ]] && lab_busy; then
    printf 'In progress: %s, started at %s.\n' "$(echo "$unfinished" | cut -d'|' -f2)" "${unfinished%%|*}"
  elif [[ -n "$unfinished" ]]; then
    local at="${unfinished%%|*}" rest="${unfinished#*|}"
    printf 'UNFINISHED: %s, started at %s, did not finish, so the shop is not\n' "${rest%%|*}" "$at"
    printf 'what it was before nor what it was meant to become. Run %s.\n' "${rest#*|}"
  fi
  active="$(in_lab 'cat /lab/active 2>/dev/null || true')"
  local running
  running="$(compose ps --status running --services 2>/dev/null | tr '\n' ' ')"
  printf 'Running:   %s\n' "${running:-nothing}"
  if [[ -z "$active" ]]; then
    printf 'Profile:   none recorded\n'
  else
    local profile="${active%% *}" manifest
    manifest="$(read_manifest "$profile" || true)"
    MANIFEST="$manifest" ACTIVE="$active" python3 -I - "$(source_fingerprint)" <<'PY'
import json, os, sys
words = os.environ["ACTIVE"].split()
print(f"Profile:   {words[0]}")
print(f"Overlays:  {', '.join(words[1:]) or 'none'}")
try:
    manifest = json.loads(os.environ["MANIFEST"])
except ValueError:
    print("Built:     no stored manifest")
else:
    dirty = ", with uncommitted lab changes" if manifest["uncommitted_lab_changes"] else ""
    print(f"Built:     {manifest['built_at']} from revision {manifest['revision']}{dirty}; its check {manifest['check']['result']}")
    if manifest["lab_fingerprint"] != sys.argv[1]:
        print("           The lab's files have changed since: rebuild it to take the change.")
PY
  fi
  if [[ " $running " == *" wordpress "* ]] && ! lab_busy; then
    wp eval '
      global $wpdb;
      printf("In the shop: profile %s, overlays %s\n", get_option("agentify_lab_profile") ?: "none",
        implode(", ", (array) get_option("agentify_lab_overlays", [])) ?: "none");
      $keys = $wpdb->get_results("SELECT description, permissions, last_access FROM {$wpdb->prefix}woocommerce_api_keys");
      printf("REST keys: %d%s\n", count($keys), $keys ? ", which a connected Agentify merchant may hold:" : "");
      foreach ($keys as $key) {
        printf("           %s, %s, last used %s\n", $key->description, $key->permissions, $key->last_access ?: "never");
      }'
  fi
  in_lab 'printf "Request log: %s in %s files\n" "$(du -sh /lab/caddy-logs | cut -f1)" "$(ls /lab/caddy-logs | wc -l)"'
}

list_profiles() {
  local manifests
  manifests="$(in_lab 'for m in /lab/profiles/*/manifest.json; do [ -e "$m" ] && cat "$m" && echo "%%"; done; true')"
  MANIFESTS="$manifests" python3 -I - <<'PY'
import json, os
manifests = [json.loads(chunk) for chunk in os.environ["MANIFESTS"].split("%%") if chunk.strip()]
if not manifests:
    print("No profile has been built yet: ./lab.sh build all")
for m in sorted(manifests, key=lambda m: m["profile"]):
    size = sum(m["bytes"].values()) / 1e6
    print("{:<14} built {} from {}, check {}, {:.0f} MB stored, {:.0f}s to build".format(
        m["profile"], m["built_at"], m["revision"], m["check"]["result"], size, m["build_seconds"]))
PY
  printf 'Not built:'
  local profile missing=""
  for profile in $PROFILES; do
    in_lab 'test -e "/lab/profiles/$1/manifest.json"' "$profile" 2>/dev/null || missing="$missing $profile"
  done
  printf '%s\n' "${missing:- none}"
}

settings() {
  local action="${1:-}" name
  case "$action" in
    save)
      name="${2:?settings save needs a name}"
      [[ "$name" =~ ^[A-Za-z0-9._-]+$ ]] || fail "a reading's name is letters, digits, dots, dashes and underscores"
      if in_lab 'test -e "/lab/readings/$1.json"' "$name"; then
        fail "a reading called $name exists; readings are evidence and are not overwritten"
      fi
      wp eval-file /seed/reading.php >"$lab_tmp/reading.json"
      python3 -I -c 'import json, sys; json.load(open(sys.argv[1]))' "$lab_tmp/reading.json" ||
        fail "the reading is not JSON"
      in_lab 'cat >"/lab/readings/$1.json"' "$name" <"$lab_tmp/reading.json"
      printf 'Reading %s taken.\n' "$name"
      ;;
    diff)
      [[ $# -eq 3 ]] || fail "settings diff needs two readings"
      in_lab 'cat "/lab/readings/$1.json"' "$2" >"$lab_tmp/a.json" || fail "there is no reading called $2"
      in_lab 'cat "/lab/readings/$1.json"' "$3" >"$lab_tmp/b.json" || fail "there is no reading called $3"
      python3 -I lib/settings_diff.py "$lab_tmp/a.json" "$lab_tmp/b.json"
      ;;
    list) in_lab 'ls -l /lab/readings' ;;
    *) fail "settings takes save, diff or list" ;;
  esac
}

show_requests() {
  in_lab 'for f in /lab/caddy-logs/access*; do
      [ -e "$f" ] || continue
      case "$f" in *.gz) gzip -dc "$f" ;; *) cat "$f" ;; esac
    done' | python3 -I lib/request_log.py "$@"
}

# Read-only, and refused rather than answered while another command changes
# the shop, since an order count taken half way through a switch is neither
# profile's.
show_orders() {
  [[ $# -le 1 ]] || fail "orders takes at most one Agentify order identifier"
  if lab_busy; then
    fail "./lab.sh $(cat "$lab_dir/.lab.lock/command" 2>/dev/null || echo '…') is changing the shop, so it was not asked; ask again once that finishes"
  fi
  compose ps --status running --services 2>/dev/null | grep -qx db ||
    fail "the shop's database is not running, so the shop was not asked"
  wp eval-file - "$@" <lib/orders.php
}

# --- Dispatch ----------------------------------------------------------------

main() {
  local command="${1:-}" target profile
  [[ -n "$command" ]] || {
    usage
    exit 2
  }
  shift

  lab_tmp="$(mktemp -d)"
  lab_lock=""
  trap 'rm -rf "$lab_tmp"; if [[ -n "$lab_lock" ]]; then rm -rf "$lab_lock"; fi' EXIT
  case "$command $*" in
    status* | list* | requests* | orders* | "settings diff"* | "settings list"* | help* | -h* | --help*) ;;
    *) take_lock "$command" "$@" ;;
  esac

  case "$command" in
    baseline) build_baseline ;;
    -h | --help | help) usage ;;
    *)
      load_env
      case "$command" in
        status) show_status ;;
        list) list_profiles ;;
        build)
          target="${1:?build needs a profile, or all}"
          if [[ "$target" == all ]]; then
            prepare_data_root
            for profile in $PROFILES; do build_profile "$profile"; done
          else
            one_of "$target" "$PROFILES" || fail "no profile is called $target; the profiles are: $PROFILES"
            prepare_data_root
            build_profile "$target"
          fi
          ;;
        switch)
          target="${1:?switch needs a profile}"
          one_of "$target" "$PROFILES" || fail "no profile is called $target; the profiles are: $PROFILES"
          switch_profile "$target"
          ;;
        overlay)
          target="${1:?overlay needs an overlay}"
          one_of "$target" "$OVERLAYS" || fail "no overlay is called $target; the overlays are: $OVERLAYS"
          lay_overlay "$target"
          ;;
        check) check_shop "$@" ;;
        settings) settings "$@" ;;
        requests) show_requests "$@" ;;
        orders) show_orders "$@" ;;
        *)
          usage
          exit 2
          ;;
      esac
      ;;
  esac
}

# The whole file is read before anything runs, so a lab checkout updated
# while a build is running does not change the build half way through.
main "$@"
exit
