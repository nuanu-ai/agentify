#!/usr/bin/env sh
set -eu

for identity_table in scanner_auth_users scanner_auth_sessions scanner_auth_accounts scanner_auth_verifications; do
  psql "$WEB_DATABASE_URL" -At -v ON_ERROR_STOP=1 -c "SELECT count(*) FROM public.$identity_table" >/dev/null
  psql "$PRIVACY_DATABASE_URL" -At -v ON_ERROR_STOP=1 -c "SELECT count(*) FROM public.$identity_table" >/dev/null
  if psql "$WORKER_DATABASE_URL" -At -v ON_ERROR_STOP=1 -c "SELECT count(*) FROM public.$identity_table" >/dev/null 2>&1; then
    echo "Worker can read scanner identity; refusing Auth activation." >&2
    exit 1
  fi
  if psql "$DASHBOARD_DATABASE_URL" -At -v ON_ERROR_STOP=1 -c "SELECT count(*) FROM public.$identity_table" >/dev/null 2>&1; then
    echo "Dashboard can read scanner identity; refusing Auth activation." >&2
    exit 1
  fi
done

psql "$ADMIN_DATABASE_URL" -At -v ON_ERROR_STOP=1 <<'SQL' >/dev/null
DO $scanner_auth_access$
DECLARE identity_table text;
BEGIN
  FOREACH identity_table IN ARRAY ARRAY[
    'scanner_auth_users', 'scanner_auth_sessions',
    'scanner_auth_accounts', 'scanner_auth_verifications'
  ] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_class WHERE oid = ('public.' || identity_table)::regclass AND relrowsecurity) THEN
      RAISE EXCEPTION 'Scanner identity RLS missing';
    END IF;
    IF NOT (has_table_privilege('agentify_web', 'public.' || identity_table, 'SELECT')
        AND has_table_privilege('agentify_web', 'public.' || identity_table, 'INSERT')
        AND has_table_privilege('agentify_web', 'public.' || identity_table, 'UPDATE')
        AND has_table_privilege('agentify_web', 'public.' || identity_table, 'DELETE')
        AND has_table_privilege('agentify_privacy', 'public.' || identity_table, 'SELECT')
        AND has_table_privilege('agentify_privacy', 'public.' || identity_table, 'DELETE')) THEN
      RAISE EXCEPTION 'Scanner web/privacy identity grants missing';
    END IF;
    IF has_table_privilege('agentify_privacy', 'public.' || identity_table, 'INSERT')
       OR has_table_privilege('agentify_privacy', 'public.' || identity_table, 'UPDATE')
       OR has_table_privilege('agentify_worker', 'public.' || identity_table, 'SELECT')
       OR has_table_privilege('agentify_dashboard', 'public.' || identity_table, 'SELECT') THEN
      RAISE EXCEPTION 'Scanner identity grant escaped its roles';
    END IF;
  END LOOP;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.leads'::regclass
      AND conname = 'leads_scanner_auth_user_id_scanner_auth_users_id_fk'
  ) THEN
    RAISE EXCEPTION 'Lead Auth link foreign key missing';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_index i
    JOIN pg_class c ON c.oid = i.indexrelid
    WHERE i.indrelid = 'public.leads'::regclass
      AND c.relname = 'leads_scanner_auth_user_id_uidx'
      AND i.indisunique
  ) THEN
    RAISE EXCEPTION 'Lead Auth link uniqueness missing';
  END IF;
END
$scanner_auth_access$;
SQL

echo "Scanner Auth tables, link constraints, RLS and role boundaries passed."
