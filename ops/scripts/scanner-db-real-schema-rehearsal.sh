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
INSERT INTO commerce_marker VALUES (1, 'synthetic-paid-order');
CREATE ROLE agentify_web LOGIN;
CREATE ROLE agentify_worker LOGIN;
CREATE ROLE agentify_privacy LOGIN;
CREATE ROLE agentify_dashboard LOGIN;
CREATE ROLE anon;
CREATE ROLE authenticated;
CREATE ROLE service_role;
CREATE DATABASE agentify_source;
SQL
export DATABASE_URL=postgresql://agentify_commerce:synthetic-only@127.0.0.1:58433/agentify_source
pnpm --filter @agentify/scanner-database build >/dev/null
cp -R packages/scanner-database/migrations "$tmp/base-migrations"
export SCANNER_BASE_MIGRATIONS="$tmp/base-migrations"
node --input-type=module <<'JS'
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
const folder = process.env.SCANNER_BASE_MIGRATIONS;
const journalPath = join(folder, 'meta', '_journal.json');
const journal = JSON.parse(readFileSync(journalPath, 'utf8'));
const identityMigrations = [
  '0015_noisy_gladiator',
  '0016_superb_zuras',
  '0017_giant_agent_zero',
];
const journalTail = journal.entries.slice(-identityMigrations.length).map(({ tag }) => tag);
if (JSON.stringify(journalTail) !== JSON.stringify(identityMigrations)) {
  throw new Error('Expected the shared-identity migrations at the end of the current scanner journal');
}
journal.entries.splice(-identityMigrations.length);
if (journal.entries.at(-1)?.tag !== '0014_merchant_web_policy') {
  throw new Error('Expected scanner restore baseline to end at migration 0014');
}
writeFileSync(journalPath, `${JSON.stringify(journal, null, 2)}\n`);
for (const tag of identityMigrations) {
  unlinkSync(join(folder, `${tag}.sql`));
  unlinkSync(join(folder, 'meta', `${tag.split('_', 1)[0]}_snapshot.json`));
}
JS
node --input-type=module >"$tmp/migrate.log" 2>&1 <<'JS' || { cat "$tmp/migrate.log" >&2; exit 1; }
import { createDatabase } from './packages/scanner-database/dist/client.js';
import { migrateDatabase } from './packages/scanner-database/dist/migrate.js';
const { db, pool } = createDatabase(process.env.DATABASE_URL, { max: 1 });
try { await migrateDatabase(db, process.env.SCANNER_BASE_MIGRATIONS); }
finally { await pool.end(); }
JS
pnpm --filter @agentify/scanner-worker exec tsx src/queue-init-cli.ts >"$tmp/queue.log" 2>&1 || { cat "$tmp/queue.log" >&2; exit 1; }
# The current aggregate views query tables introduced by migration 0016. Keep
# the required dump schema at the 0014 restore baseline, then install the views
# after the restored target reaches the current schema.
docker exec -i "$container" psql -U agentify_commerce -d agentify_source -v ON_ERROR_STOP=1 \
  >/dev/null <<'SQL'
CREATE SCHEMA metabase;
REVOKE ALL ON SCHEMA metabase FROM PUBLIC;
SQL
docker exec -i "$container" psql -U agentify_commerce -d agentify_source -v ON_ERROR_STOP=1 >/dev/null <<'SQL'
INSERT INTO public.sessions(id, anonymous_id_hash) VALUES
  ('0199b3e4-27a2-7c13-8c17-000000000001', 'synthetic-anonymous-hash');
INSERT INTO public.leads(id, email_normalized_ciphertext, email_lookup_hash, role, first_segment, first_session_id, supabase_user_id)
VALUES ('0199b3e4-27a2-7c13-8c17-000000000002', 'synthetic-ciphertext', 'synthetic-lookup-hash', 'owner', 'owner',
  '0199b3e4-27a2-7c13-8c17-000000000001', '0199b3e4-27a2-7c13-8c17-000000000099');
INSERT INTO public.scans(
  id, session_id, lead_id, segment, rubric_version, submitted_url_redacted,
  canonical_target_url, target_host, target_hash, access_token_hash,
  access_token_expires_at, idempotency_key_hash, idempotency_body_hash
) VALUES (
  '0199b3e4-27a2-7c13-8c17-000000000004',
  '0199b3e4-27a2-7c13-8c17-000000000001',
  '0199b3e4-27a2-7c13-8c17-000000000002', 'owner', 'synthetic-rubric',
  'https://example.invalid', 'https://example.invalid/', 'example.invalid',
  'synthetic-target-hash', 'synthetic-access-hash', now() + interval '1 day',
  'synthetic-idempotency-hash', 'synthetic-idempotency-body-hash'
);
INSERT INTO public.lead_scans(lead_id, scan_id, site_ownership_claim) VALUES
  ('0199b3e4-27a2-7c13-8c17-000000000002', '0199b3e4-27a2-7c13-8c17-000000000004', true);
INSERT INTO public.report_sessions(id, lead_id, session_token_hash, expires_at)
VALUES ('0199b3e4-27a2-7c13-8c17-000000000003', '0199b3e4-27a2-7c13-8c17-000000000002',
  'synthetic-report-hash', now() + interval '1 day');
INSERT INTO public.waitlist_entries(id, lead_id, scan_id, pain_answer)
VALUES ('0199b3e4-27a2-7c13-8c17-000000000005', '0199b3e4-27a2-7c13-8c17-000000000002',
  '0199b3e4-27a2-7c13-8c17-000000000004', 'Synthetic waitlist answer');
SQL
docker exec "$container" pg_dump -U agentify_commerce -d agentify_source --format=custom --no-owner --no-acl \
  --schema=public --schema=pgboss --schema=drizzle --schema=metabase > "$tmp/source.dump"
docker exec -i "$container" psql -U agentify_commerce -d agentify_source -At -F '|' -v ON_ERROR_STOP=1 \
  < deploy/ansible/scanner-fingerprint.sql > "$tmp/source.fingerprint"
chmod 600 "$tmp/source.dump" "$tmp/source.fingerprint"
export SCANNER_REHEARSAL=1 SCANNER_TARGET_CONTAINER="$container" \
  SCANNER_DUMP="$tmp/source.dump" SCANNER_SOURCE_FINGERPRINT="$tmp/source.fingerprint" \
  SCANNER_DUMP_SHA256="$(shasum -a 256 "$tmp/source.dump" | cut -d ' ' -f 1)" \
  SCANNER_SOURCE_SHA256="$(shasum -a 256 "$tmp/source.fingerprint" | cut -d ' ' -f 1)" \
  SCANNER_SOURCE_PG_MAJOR=17 SCANNER_RELEASE_SHA=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
bash deploy/ansible/scanner-db-restore.sh
DATABASE_URL=postgresql://agentify_commerce:synthetic-only@127.0.0.1:58433/agentify_scanner \
  pnpm --filter @agentify/scanner-worker exec tsx src/queue-init-cli.ts >"$tmp/target-queue.log" 2>&1 || { cat "$tmp/target-queue.log" >&2; exit 1; }
docker exec -i "$container" psql -U agentify_commerce -d agentify_scanner -v ON_ERROR_STOP=1 >/dev/null <<'SQL'
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
if docker exec "$container" psql -U agentify_commerce -d agentify_scanner -v ON_ERROR_STOP=1 -c \
  'SET ROLE agentify_worker; SELECT count(*) FROM public.leads' >"$tmp/worker-access.log" 2>&1; then
  echo 'Worker can read protected leads.' >&2; exit 1
fi
if docker exec "$container" psql -U agentify_commerce -d agentify_scanner -v ON_ERROR_STOP=1 -c \
  'SET ROLE agentify_dashboard; SELECT count(*) FROM public.leads' >"$tmp/dashboard-access.log" 2>&1; then
  echo 'Dashboard can read protected leads.' >&2; exit 1
fi
docker exec -i "$container" psql -U agentify_commerce -d agentify_scanner -At -F '|' -v ON_ERROR_STOP=1 \
  < deploy/ansible/scanner-fingerprint.sql > "$tmp/after-queue.fingerprint"
cmp "$tmp/source.fingerprint" "$tmp/after-queue.fingerprint"
docker exec -i "$container" psql -U agentify_commerce -d agentify_scanner -At -F '|' -v ON_ERROR_STOP=1 \
  < deploy/ansible/scanner-report-continuity.sql > "$tmp/pre-report-continuity"
DATABASE_URL=postgresql://agentify_commerce:synthetic-only@127.0.0.1:58433/agentify_scanner \
  pnpm --filter @agentify/scanner-database db:migrate >"$tmp/identity-migrate.log" 2>&1 || { cat "$tmp/identity-migrate.log" >&2; exit 1; }
DATABASE_URL=postgresql://agentify_commerce:synthetic-only@127.0.0.1:58433/agentify_scanner \
  pnpm --filter @agentify/scanner-worker exec tsx src/queue-init-cli.ts >"$tmp/identity-queue.log" 2>&1 || { cat "$tmp/identity-queue.log" >&2; exit 1; }
docker exec -i "$container" psql -U agentify_commerce -d agentify_scanner -v ON_ERROR_STOP=1 \
  < ops/dashboards/install-aggregate-views.sql >/dev/null
docker exec -i "$container" psql -U agentify_commerce -d agentify_scanner -At -F '|' -v ON_ERROR_STOP=1 \
  < deploy/ansible/scanner-report-continuity.sql > "$tmp/post-report-continuity"
cmp "$tmp/pre-report-continuity" "$tmp/post-report-continuity"
verify_report_access() {
  docker exec -i \
    -e 'ADMIN_DATABASE_URL=postgresql:///agentify_scanner?user=agentify_commerce' \
    -e 'WEB_DATABASE_URL=postgresql:///agentify_scanner?user=agentify_web' \
    -e 'WORKER_DATABASE_URL=postgresql:///agentify_scanner?user=agentify_worker' \
    -e 'PRIVACY_DATABASE_URL=postgresql:///agentify_scanner?user=agentify_privacy' \
    -e 'DASHBOARD_DATABASE_URL=postgresql:///agentify_scanner?user=agentify_dashboard' \
    "$container" /bin/sh < deploy/ansible/verify-scanner-report-access.sh
}
verify_report_access
docker exec "$container" psql -U agentify_commerce -d agentify_scanner -v ON_ERROR_STOP=1 -c \
  'GRANT SELECT ON public.scanner_recovery_intents TO agentify_worker' >/dev/null
if verify_report_access >"$tmp/report-access-mutation.log" 2>&1; then
  echo 'Report identity access check survived a worker grant.' >&2; exit 1
fi
printf 'Report identity access check rejected a synthetic worker grant.\n'
docker exec "$container" psql -U agentify_commerce -d agentify_scanner -v ON_ERROR_STOP=1 -c \
  'REVOKE SELECT ON public.scanner_recovery_intents FROM agentify_worker' >/dev/null
verify_report_access
docker exec "$container" psql -U agentify_commerce -d agentify_scanner -v ON_ERROR_STOP=1 -c \
  'SET ROLE agentify_dashboard; SELECT count(*) FROM metabase.operator_overview' >/dev/null
[[ "$(docker exec "$container" psql -U agentify_commerce -d agentify_commerce -Atc 'select value from commerce_marker')" == synthetic-paid-order ]]
[[ "$(docker exec "$container" psql -U agentify_commerce -d agentify_scanner -Atc 'select count(*) from public.report_sessions')" == 1 ]]
[[ "$(docker exec "$container" psql -U agentify_commerce -d agentify_scanner -Atc 'select count(*) from pgboss.job')" =~ ^[0-9]+$ ]]
[[ "$(docker exec "$container" psql -U agentify_commerce -d agentify_scanner -Atc "select count(*) from pg_policy p join pg_class c on c.oid=p.polrelid where c.relname='leads' and p.polname='agentify_web_service'")" == 1 ]]
[[ "$(docker exec "$container" psql -U agentify_commerce -d agentify_scanner -Atc "select count(*) from pg_roles where rolname in ('agentify_web','agentify_worker','agentify_privacy','agentify_dashboard') and rolcanlogin and not (rolsuper or rolcreatedb or rolcreaterole or rolbypassrls)")" == 4 ]]
docker exec "$container" psql -U agentify_commerce -d agentify_scanner -v ON_ERROR_STOP=1 -c \
  "update public.report_sessions set last_seen_at=last_seen_at + interval '1 second' where session_token_hash='synthetic-report-hash'" >/dev/null
docker exec -i "$container" psql -U agentify_commerce -d agentify_scanner -At -F '|' -v ON_ERROR_STOP=1 \
  < deploy/ansible/scanner-report-continuity.sql > "$tmp/mutated-report-continuity"
if cmp -s "$tmp/post-report-continuity" "$tmp/mutated-report-continuity"; then
  echo 'Lead/report continuity check survived a report-session mutation.' >&2; exit 1
fi
printf 'Report continuity check detected a synthetic session mutation.\n'
printf 'Real scanner migrations, report identity RLS, report data/views, queue data and commerce isolation survived restore/bootstrap.\n'
