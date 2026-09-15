#!/usr/bin/env bash
# Uses the repository's current scanner migrations and queue bootstrap against
# a disposable local server. No production credential or container is read.
set -euo pipefail
cd "$(dirname "$0")/../.."
container=scanner-exit-rehearsal-real-postgres-1
cleanup() { docker rm -f "$container" >/dev/null 2>&1 || true; rm -rf "$tmp"; }
if docker inspect "$container" >/dev/null 2>&1; then
  echo 'Existing real-schema rehearsal container requires inspection.' >&2
  exit 1
fi
tmp="$(mktemp -d "${TMPDIR:-/tmp}/scanner-exit-real.XXXXXX")"
chmod 700 "$tmp"
docker run -d --name "$container" -p 127.0.0.1:58433:5432 \
  --label com.docker.compose.project=scanner-exit-rehearsal \
  --label com.docker.compose.service=postgres \
  -e POSTGRES_USER=coinslot -e POSTGRES_DB=coinslot \
  -e POSTGRES_PASSWORD=synthetic-only postgres:17-alpine >/dev/null
trap cleanup EXIT
for _ in {1..30}; do
  docker exec "$container" pg_isready -U coinslot -d coinslot >/dev/null 2>&1 && break
  sleep 1
done
docker exec "$container" pg_isready -U coinslot -d coinslot >/dev/null
docker exec -i "$container" psql -U coinslot -d coinslot -v ON_ERROR_STOP=1 >/dev/null <<'SQL'
CREATE TABLE commerce_marker(id int PRIMARY KEY, value text NOT NULL);
INSERT INTO commerce_marker VALUES (1, 'synthetic-paid-order');
CREATE ROLE agentify_web LOGIN;
CREATE ROLE agentify_worker LOGIN;
CREATE ROLE agentify_privacy LOGIN;
CREATE ROLE agentify_dashboard LOGIN;
CREATE DATABASE agentify_source;
SQL
export DATABASE_URL=postgresql://coinslot:synthetic-only@127.0.0.1:58433/agentify_source
pnpm --filter @agentify/scanner-database build >/dev/null
pnpm --filter @agentify/scanner-database db:migrate >"$tmp/migrate.log" 2>&1 || { cat "$tmp/migrate.log" >&2; exit 1; }
pnpm --filter @agentify/scanner-worker exec tsx src/queue-init-cli.ts >"$tmp/queue.log" 2>&1 || { cat "$tmp/queue.log" >&2; exit 1; }
docker exec -i "$container" psql -U coinslot -d agentify_source -v ON_ERROR_STOP=1 \
  < ops/dashboards/install-aggregate-views.sql >/dev/null
docker exec -i "$container" psql -U coinslot -d agentify_source -v ON_ERROR_STOP=1 >/dev/null <<'SQL'
INSERT INTO public.sessions(id, anonymous_id_hash) VALUES
  ('0199b3e4-27a2-7c13-8c17-000000000001', 'synthetic-anonymous-hash');
INSERT INTO public.leads(id, email_normalized_ciphertext, email_lookup_hash, role, first_segment, first_session_id, supabase_user_id)
VALUES ('0199b3e4-27a2-7c13-8c17-000000000002', 'synthetic-ciphertext', 'synthetic-lookup-hash', 'owner', 'owner',
  '0199b3e4-27a2-7c13-8c17-000000000001', '0199b3e4-27a2-7c13-8c17-000000000099');
INSERT INTO public.report_sessions(id, lead_id, session_token_hash, expires_at)
VALUES ('0199b3e4-27a2-7c13-8c17-000000000003', '0199b3e4-27a2-7c13-8c17-000000000002',
  'synthetic-report-hash', now() + interval '1 day');
SQL
docker exec "$container" pg_dump -U coinslot -d agentify_source --format=custom --no-owner --no-acl \
  --schema=public --schema=pgboss --schema=drizzle --schema=metabase > "$tmp/source.dump"
docker exec -i "$container" psql -U coinslot -d agentify_source -At -F '|' -v ON_ERROR_STOP=1 \
  < deploy/ansible/scanner-fingerprint.sql > "$tmp/source.fingerprint"
chmod 600 "$tmp/source.dump" "$tmp/source.fingerprint"
export SCANNER_REHEARSAL=1 SCANNER_TARGET_CONTAINER="$container" \
  SCANNER_DUMP="$tmp/source.dump" SCANNER_SOURCE_FINGERPRINT="$tmp/source.fingerprint" \
  SCANNER_DUMP_SHA256="$(shasum -a 256 "$tmp/source.dump" | cut -d ' ' -f 1)" \
  SCANNER_SOURCE_SHA256="$(shasum -a 256 "$tmp/source.fingerprint" | cut -d ' ' -f 1)" \
  SCANNER_SOURCE_PG_MAJOR=17 SCANNER_RELEASE_SHA=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
bash deploy/ansible/scanner-db-restore.sh
DATABASE_URL=postgresql://coinslot:synthetic-only@127.0.0.1:58433/agentify_scanner \
  pnpm --filter @agentify/scanner-worker exec tsx src/queue-init-cli.ts >"$tmp/target-queue.log" 2>&1 || { cat "$tmp/target-queue.log" >&2; exit 1; }
docker exec -i "$container" psql -U coinslot -d agentify_scanner -v ON_ERROR_STOP=1 >/dev/null <<'SQL'
GRANT CONNECT ON DATABASE agentify_scanner TO agentify_web, agentify_worker, agentify_privacy, agentify_dashboard;
GRANT USAGE ON SCHEMA public TO agentify_web, agentify_worker, agentify_privacy;
REVOKE ALL ON SCHEMA public FROM agentify_dashboard;
SET ROLE agentify_web;
SELECT count(*) FROM public.leads;
RESET ROLE;
SET ROLE agentify_privacy;
SELECT count(*) FROM public.leads;
RESET ROLE;
SQL
if docker exec "$container" psql -U coinslot -d agentify_scanner -v ON_ERROR_STOP=1 -c \
  'SET ROLE agentify_worker; SELECT count(*) FROM public.leads' >"$tmp/worker-access.log" 2>&1; then
  echo 'Worker can read protected leads.' >&2; exit 1
fi
if docker exec "$container" psql -U coinslot -d agentify_scanner -v ON_ERROR_STOP=1 -c \
  'SET ROLE agentify_dashboard; SELECT count(*) FROM public.leads' >"$tmp/dashboard-access.log" 2>&1; then
  echo 'Dashboard can read protected leads.' >&2; exit 1
fi
docker exec -i "$container" psql -U coinslot -d agentify_scanner -At -F '|' -v ON_ERROR_STOP=1 \
  < deploy/ansible/scanner-fingerprint.sql > "$tmp/after-queue.fingerprint"
cmp "$tmp/source.fingerprint" "$tmp/after-queue.fingerprint"
[[ "$(docker exec "$container" psql -U coinslot -d coinslot -Atc 'select value from commerce_marker')" == synthetic-paid-order ]]
[[ "$(docker exec "$container" psql -U coinslot -d agentify_scanner -Atc 'select count(*) from public.report_sessions')" == 1 ]]
[[ "$(docker exec "$container" psql -U coinslot -d agentify_scanner -Atc 'select count(*) from pgboss.job')" =~ ^[0-9]+$ ]]
[[ "$(docker exec "$container" psql -U coinslot -d agentify_scanner -Atc "select count(*) from pg_policy p join pg_class c on c.oid=p.polrelid where c.relname='leads' and p.polname='agentify_web_service'")" == 1 ]]
[[ "$(docker exec "$container" psql -U coinslot -d agentify_scanner -Atc "select count(*) from pg_roles where rolname in ('agentify_web','agentify_worker','agentify_privacy','agentify_dashboard') and rolcanlogin and not (rolsuper or rolcreatedb or rolcreaterole or rolbypassrls)")" == 4 ]]
printf 'Real scanner migrations, RLS role access, report session, queue data and commerce isolation survived restore/bootstrap.\n'
