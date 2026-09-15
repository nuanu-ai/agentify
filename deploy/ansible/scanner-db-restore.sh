#!/usr/bin/env bash
# Only for Ansible's guarded scanner DB restore phase. No commerce SQL writes.
set -euo pipefail
umask 077

: "${SCANNER_DUMP:?protected scanner dump required}"
: "${SCANNER_SOURCE_FINGERPRINT:?protected source fingerprint required}"
: "${SCANNER_DUMP_SHA256:?explicit dump SHA256 required}"
: "${SCANNER_SOURCE_SHA256:?explicit fingerprint SHA256 required}"
: "${SCANNER_RELEASE_SHA:?reviewed release SHA required}"
: "${SCANNER_SOURCE_PG_MAJOR:?observed source PostgreSQL major required}"
fail() { printf 'Scanner restore refused: %s\n' "$1" >&2; exit 1; }
file_mode() { stat -c %a "$1" 2>/dev/null || stat -f %Lp "$1"; }
file_sha256() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d ' ' -f 1
  else
    shasum -a 256 "$1" | cut -d ' ' -f 1
  fi
}
container="${SCANNER_TARGET_CONTAINER:-agentify-commerce-postgres-1}"
expected_project=agentify-commerce
if [[ "${SCANNER_REHEARSAL:-}" == 1 ]]; then
  [[ "$container" == scanner-exit-rehearsal-* ]] || fail 'rehearsal target name is not isolated'
  expected_project=scanner-exit-rehearsal
fi
target_db=agentify_scanner
source_db=coinslot
script_dir="$(cd "$(dirname "$0")" && pwd)"

[[ "$SCANNER_DUMP_SHA256" =~ ^[a-f0-9]{64}$ ]] || fail 'invalid dump checksum'
[[ "$SCANNER_SOURCE_SHA256" =~ ^[a-f0-9]{64}$ ]] || fail 'invalid fingerprint checksum'
[[ "$SCANNER_RELEASE_SHA" =~ ^[a-f0-9]{40}$ ]] || fail 'invalid release SHA'
[[ "$SCANNER_SOURCE_PG_MAJOR" =~ ^[0-9]+$ ]] || fail 'invalid source PostgreSQL major'
[[ -f "$SCANNER_DUMP" && -f "$SCANNER_SOURCE_FINGERPRINT" ]] || fail 'source artifacts missing'
[[ "$(file_mode "$SCANNER_DUMP")" == 600 ]] || fail 'dump must be 0600'
[[ "$(file_mode "$SCANNER_SOURCE_FINGERPRINT")" == 600 ]] || fail 'fingerprint must be 0600'
[[ "$(file_sha256 "$SCANNER_DUMP")" == "$SCANNER_DUMP_SHA256" ]] || fail 'dump checksum changed'
[[ "$(file_sha256 "$SCANNER_SOURCE_FINGERPRINT")" == "$SCANNER_SOURCE_SHA256" ]] || fail 'fingerprint checksum changed'

identity="$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project"}}|{{index .Config.Labels "com.docker.compose.service"}}|{{.State.Running}}' "$container")"
[[ "$identity" == "$expected_project|postgres|true" ]] || fail 'wrong or stopped target container'
docker exec "$container" psql -U coinslot -d "$source_db" -At -v ON_ERROR_STOP=1 -c 'select current_database()' | grep -qx "$source_db" || fail 'commerce connection mismatch'
target_major="$(docker exec "$container" psql -U coinslot -d "$source_db" -At -v ON_ERROR_STOP=1 -c "select current_setting('server_version_num')::int / 10000")"
[[ "$target_major" == 17 && "$SCANNER_SOURCE_PG_MAJOR" -le "$target_major" ]] || fail 'source/target PostgreSQL majors require a reviewed compatible restore'
db_count="$(docker exec "$container" psql -U coinslot -d "$source_db" -At -v ON_ERROR_STOP=1 -c "select count(*) from pg_database where datname='$target_db'")"
[[ "$db_count" == 0 ]] || fail 'scanner target database already exists; never overwrite or retry in place'

restore_list="$(docker exec -i "$container" pg_restore --list < "$SCANNER_DUMP")"
if grep -Eq '(^| )SCHEMA[[:space:]]+-[[:space:]]+(auth|storage|realtime)|(^| )DATABASE[[:space:]]' <<< "$restore_list"; then
  fail 'dump includes a managed identity schema or database creation'
fi
for schema in public pgboss drizzle metabase; do
  grep -Eq "SCHEMA[[:space:]]+-[[:space:]]+$schema([[:space:]]|$)" <<< "$restore_list" || fail "missing $schema schema"
done

# PostgreSQL restores policy TO references even with --no-acl. Define only the
# four scanner runtime principals before importing policy DDL; their grants
# and login credentials are reconciled separately after the row comparison.
docker exec -i "$container" psql -U coinslot -d "$source_db" -v ON_ERROR_STOP=1 >/dev/null <<'SQL'
DO $scanner_roles$
DECLARE role_name text;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['agentify_web','agentify_worker','agentify_privacy','agentify_dashboard'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname=role_name AND (NOT rolcanlogin OR rolsuper OR rolcreatedb OR rolcreaterole OR rolbypassrls)) THEN
      RAISE EXCEPTION 'existing scanner role has elevated privileges';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN
      EXECUTE format('CREATE ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS', role_name);
    END IF;
  END LOOP;
END
$scanner_roles$;
SQL

# Creation is deliberately one-shot. A restore failure leaves a named database
# for forensic inspection; an operator must resolve it before any retry.
docker exec "$container" createdb -U coinslot -O coinslot "$target_db"
docker exec "$container" psql -U coinslot -d "$target_db" -v ON_ERROR_STOP=1 -c \
  'DROP SCHEMA public CASCADE' >/dev/null
docker exec -i "$container" pg_restore -U coinslot -d "$target_db" \
  --exit-on-error --single-transaction --no-owner --no-acl < "$SCANNER_DUMP"

target_fingerprint="$(mktemp)"
trap 'rm -f "$target_fingerprint"' EXIT
docker exec -i "$container" psql -U coinslot -d "$target_db" -At -F '|' -v ON_ERROR_STOP=1 \
  < "$script_dir/scanner-fingerprint.sql" > "$target_fingerprint"
cmp -s "$SCANNER_SOURCE_FINGERPRINT" "$target_fingerprint" || fail 'restored table data differs from frozen source'
printf 'Scanner DB restored and data fingerprints match. Target=%s; release=%s; dump_sha256=%s.\n' \
  "$target_db" "$SCANNER_RELEASE_SHA" "$SCANNER_DUMP_SHA256"
