#!/usr/bin/env bash
# Disposable synthetic source/target only. No production URL or host is read.
set -euo pipefail
cd "$(dirname "$0")/../.."
container=scanner-exit-rehearsal-postgres-1
cleanup() { docker rm -f "$container" >/dev/null 2>&1 || true; rm -rf "$tmp"; }
if docker inspect "$container" >/dev/null 2>&1; then
  echo 'Existing rehearsal container requires inspection; refusing to remove it.' >&2
  exit 1
fi
tmp="$(mktemp -d "${TMPDIR:-/tmp}/scanner-exit-rehearsal.XXXXXX")"
chmod 700 "$tmp"
docker run -d --name "$container" \
  --label com.docker.compose.project=scanner-exit-rehearsal \
  --label com.docker.compose.service=postgres \
  -e POSTGRES_USER=agentify_commerce -e POSTGRES_DB=agentify_commerce \
  -e POSTGRES_PASSWORD=synthetic-only postgres:17-alpine >/dev/null
trap cleanup EXIT
for _ in {1..30}; do
  docker exec "$container" pg_isready -U agentify_commerce -d agentify_commerce >/dev/null 2>&1 && break
  sleep 1
done
docker exec "$container" pg_isready -U agentify_commerce -d agentify_commerce >/dev/null
docker exec -i "$container" psql -U agentify_commerce -d agentify_commerce -v ON_ERROR_STOP=1 >/dev/null <<'SQL'
CREATE TABLE commerce_marker(id int PRIMARY KEY, value text NOT NULL);
INSERT INTO commerce_marker VALUES (1, 'paid-order-preserved');
CREATE DATABASE agentify_source;
SQL
docker exec -i "$container" psql -U agentify_commerce -d agentify_source -v ON_ERROR_STOP=1 >/dev/null <<'SQL'
CREATE SCHEMA pgboss;
CREATE SCHEMA drizzle;
CREATE SCHEMA metabase;
CREATE TABLE public.leads(id uuid PRIMARY KEY, encrypted_email text NOT NULL, supabase_user_id uuid);
CREATE TABLE public.scans(id int PRIMARY KEY, lead_id uuid REFERENCES public.leads(id), report_session text);
CREATE TABLE pgboss.job(id int PRIMARY KEY, state text NOT NULL, payload jsonb);
CREATE TABLE drizzle.__drizzle_migrations(id int PRIMARY KEY, hash text NOT NULL);
CREATE TABLE metabase.settings(id int PRIMARY KEY, name text NOT NULL);
ALTER TABLE public.leads ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.leads FORCE ROW LEVEL SECURITY;
CREATE ROLE agentify_web LOGIN;
CREATE POLICY agentify_web_service ON public.leads TO agentify_web USING (true) WITH CHECK (true);
GRANT USAGE ON SCHEMA public TO agentify_web;
GRANT SELECT ON public.leads TO agentify_web;
INSERT INTO public.leads VALUES ('00000000-0000-0000-0000-000000000001', 'synthetic-ciphertext', '00000000-0000-0000-0000-000000000099');
INSERT INTO public.scans VALUES (7, '00000000-0000-0000-0000-000000000001', 'synthetic-report');
INSERT INTO pgboss.job VALUES (3, 'created', '{"retry":1}');
INSERT INTO drizzle.__drizzle_migrations VALUES (1, 'synthetic-migration');
INSERT INTO metabase.settings VALUES (1, 'synthetic-setting');
SQL
docker exec "$container" pg_dump -U agentify_commerce -d agentify_source --format=custom \
  --no-owner --no-acl --schema=public --schema=pgboss --schema=drizzle --schema=metabase > "$tmp/source.dump"
docker exec -i "$container" psql -U agentify_commerce -d agentify_source -At -F '|' -v ON_ERROR_STOP=1 \
  < deploy/ansible/scanner-fingerprint.sql > "$tmp/source.fingerprint"
chmod 600 "$tmp/source.dump" "$tmp/source.fingerprint"
dump_sha="$(shasum -a 256 "$tmp/source.dump" | cut -d ' ' -f 1)"
fingerprint_sha="$(shasum -a 256 "$tmp/source.fingerprint" | cut -d ' ' -f 1)"
export SCANNER_REHEARSAL=1 SCANNER_TARGET_CONTAINER="$container" \
  SCANNER_DUMP="$tmp/source.dump" SCANNER_SOURCE_FINGERPRINT="$tmp/source.fingerprint" \
  SCANNER_DUMP_SHA256="$dump_sha" SCANNER_SOURCE_SHA256="$fingerprint_sha" \
  SCANNER_SOURCE_PG_MAJOR=17 \
  SCANNER_RELEASE_SHA=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa

if SCANNER_DUMP_SHA256=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb \
  bash deploy/ansible/scanner-db-restore.sh >"$tmp/negative.log" 2>&1; then
  echo 'Bad dump checksum survived.' >&2; exit 1
fi
grep -q 'dump checksum changed' "$tmp/negative.log"
bash deploy/ansible/scanner-db-restore.sh
marker="$(docker exec "$container" psql -U agentify_commerce -d agentify_commerce -Atc 'select value from commerce_marker where id=1')"
[[ "$marker" == paid-order-preserved ]]
queue="$(docker exec "$container" psql -U agentify_commerce -d agentify_scanner -Atc 'select state from pgboss.job where id=3')"
[[ "$queue" == created ]]
if bash deploy/ansible/scanner-db-restore.sh >"$tmp/repeat.log" 2>&1; then
  echo 'Active target overwrite survived.' >&2; exit 1
fi
grep -q 'already exists' "$tmp/repeat.log"
docker exec "$container" psql -U agentify_commerce -d agentify_scanner -v ON_ERROR_STOP=1 -c \
  "update pgboss.job set state='completed' where id=3" >/dev/null
docker exec -i "$container" psql -U agentify_commerce -d agentify_scanner -At -F '|' -v ON_ERROR_STOP=1 \
  < deploy/ansible/scanner-fingerprint.sql > "$tmp/mutated.fingerprint"
if cmp -s "$tmp/source.fingerprint" "$tmp/mutated.fingerprint"; then
  echo 'Queue mutation survived fingerprint comparison.' >&2; exit 1
fi
printf 'Synthetic restore, commerce isolation, refusal controls, and queue mutation check passed.\n'
