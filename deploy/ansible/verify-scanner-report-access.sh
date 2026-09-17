#!/usr/bin/env sh
set -eu

for identity_table in scanner_recovery_intents scanner_identity_completions; do
  psql "$WEB_DATABASE_URL" -At -v ON_ERROR_STOP=1 -c "SELECT count(*) FROM public.$identity_table" >/dev/null
  psql "$PRIVACY_DATABASE_URL" -At -v ON_ERROR_STOP=1 -c "SELECT count(*) FROM public.$identity_table" >/dev/null
  if psql "$WORKER_DATABASE_URL" -At -v ON_ERROR_STOP=1 -c "SELECT count(*) FROM public.$identity_table" >/dev/null 2>&1; then
    echo "Worker can read scanner report identity; refusing activation." >&2
    exit 1
  fi
  if psql "$DASHBOARD_DATABASE_URL" -At -v ON_ERROR_STOP=1 -c "SELECT count(*) FROM public.$identity_table" >/dev/null 2>&1; then
    echo "Dashboard can read scanner report identity; refusing activation." >&2
    exit 1
  fi
done

psql "$WEB_DATABASE_URL" -At -v ON_ERROR_STOP=1 \
  -c 'SELECT count(*) FROM public.scanner_identity_deletion_operations' >/dev/null
for denied_database_url in "$PRIVACY_DATABASE_URL" "$WORKER_DATABASE_URL" "$DASHBOARD_DATABASE_URL"; do
  if psql "$denied_database_url" -At -v ON_ERROR_STOP=1 \
    -c 'SELECT count(*) FROM public.scanner_identity_deletion_operations' >/dev/null 2>&1; then
    echo "A non-web role can read scanner identity deletion operations; refusing activation." >&2
    exit 1
  fi
done

psql "$ADMIN_DATABASE_URL" -At -v ON_ERROR_STOP=1 <<'SQL' >/dev/null
DO $scanner_report_identity_access$
DECLARE identity_table text;
DECLARE forbidden_role text;
DECLARE privacy_table text;
BEGIN
  FOREACH identity_table IN ARRAY ARRAY[
    'scanner_recovery_intents',
    'scanner_identity_completions',
    'scanner_identity_deletion_operations'
  ] LOOP
    IF to_regclass('public.' || identity_table) IS NULL THEN
      RAISE EXCEPTION 'Scanner report identity table missing: %', identity_table;
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM pg_class
      WHERE oid = ('public.' || identity_table)::regclass AND relrowsecurity
    ) THEN
      RAISE EXCEPTION 'Scanner report identity RLS missing: %', identity_table;
    END IF;
    IF NOT (has_table_privilege('agentify_web', 'public.' || identity_table, 'SELECT')
        AND has_table_privilege('agentify_web', 'public.' || identity_table, 'INSERT')
        AND has_table_privilege('agentify_web', 'public.' || identity_table, 'UPDATE')
        AND has_table_privilege('agentify_web', 'public.' || identity_table, 'DELETE')) THEN
      RAISE EXCEPTION 'Scanner web report identity grants missing: %', identity_table;
    END IF;
    IF has_table_privilege('agentify_web', 'public.' || identity_table, 'TRUNCATE')
       OR has_table_privilege('agentify_web', 'public.' || identity_table, 'REFERENCES')
       OR has_table_privilege('agentify_web', 'public.' || identity_table, 'TRIGGER') THEN
      RAISE EXCEPTION 'Scanner web has non-runtime report identity grants: %', identity_table;
    END IF;
    IF NOT EXISTS (
      SELECT 1
      FROM pg_policy policy
      WHERE policy.polrelid = ('public.' || identity_table)::regclass
        AND policy.polname = 'scanner_report_identity_web'
        AND policy.polcmd = '*'
        AND policy.polroles = ARRAY[(SELECT oid FROM pg_roles WHERE rolname = 'agentify_web')]::oid[]
        AND pg_get_expr(policy.polqual, policy.polrelid) = 'true'
        AND pg_get_expr(policy.polwithcheck, policy.polrelid) = 'true'
    ) THEN
      RAISE EXCEPTION 'Scanner web report identity policy missing: %', identity_table;
    END IF;
    IF NOT EXISTS (
      SELECT 1
      FROM pg_policy policy
      WHERE policy.polrelid = ('public.' || identity_table)::regclass
        AND policy.polname = 'agentify_web_service'
        AND policy.polcmd = '*'
        AND policy.polroles = ARRAY[(SELECT oid FROM pg_roles WHERE rolname = 'agentify_web')]::oid[]
        AND pg_get_expr(policy.polqual, policy.polrelid) = 'true'
        AND pg_get_expr(policy.polwithcheck, policy.polrelid) = 'true'
    ) THEN
      RAISE EXCEPTION 'Queue bootstrap web policy missing from scanner report identity: %', identity_table;
    END IF;
    FOREACH forbidden_role IN ARRAY ARRAY[
      'anon', 'authenticated', 'service_role', 'agentify_worker', 'agentify_dashboard'
    ] LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = forbidden_role)
         AND (has_table_privilege(forbidden_role, 'public.' || identity_table, 'SELECT')
           OR has_table_privilege(forbidden_role, 'public.' || identity_table, 'INSERT')
           OR has_table_privilege(forbidden_role, 'public.' || identity_table, 'UPDATE')
           OR has_table_privilege(forbidden_role, 'public.' || identity_table, 'DELETE')
           OR has_table_privilege(forbidden_role, 'public.' || identity_table, 'TRUNCATE')
           OR has_table_privilege(forbidden_role, 'public.' || identity_table, 'REFERENCES')
           OR has_table_privilege(forbidden_role, 'public.' || identity_table, 'TRIGGER')) THEN
        RAISE EXCEPTION 'Scanner report identity grant escaped to role % on %', forbidden_role, identity_table;
      END IF;
    END LOOP;
  END LOOP;

  FOREACH privacy_table IN ARRAY ARRAY[
    'scanner_recovery_intents', 'scanner_identity_completions'
  ] LOOP
    IF NOT (has_table_privilege('agentify_privacy', 'public.' || privacy_table, 'SELECT')
        AND has_table_privilege('agentify_privacy', 'public.' || privacy_table, 'DELETE'))
       OR has_table_privilege('agentify_privacy', 'public.' || privacy_table, 'INSERT')
       OR has_table_privilege('agentify_privacy', 'public.' || privacy_table, 'UPDATE')
       OR has_table_privilege('agentify_privacy', 'public.' || privacy_table, 'TRUNCATE')
       OR has_table_privilege('agentify_privacy', 'public.' || privacy_table, 'REFERENCES')
       OR has_table_privilege('agentify_privacy', 'public.' || privacy_table, 'TRIGGER') THEN
      RAISE EXCEPTION 'Scanner privacy report identity grants are wrong: %', privacy_table;
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM pg_policy policy
      WHERE policy.polrelid = ('public.' || privacy_table)::regclass
        AND policy.polname = 'scanner_report_identity_privacy_select'
        AND policy.polcmd = 'r'
        AND policy.polroles = ARRAY[(SELECT oid FROM pg_roles WHERE rolname = 'agentify_privacy')]::oid[]
        AND pg_get_expr(policy.polqual, policy.polrelid) = 'true'
    ) OR NOT EXISTS (
      SELECT 1 FROM pg_policy policy
      WHERE policy.polrelid = ('public.' || privacy_table)::regclass
        AND policy.polname = 'scanner_report_identity_privacy_delete'
        AND policy.polcmd = 'd'
        AND policy.polroles = ARRAY[(SELECT oid FROM pg_roles WHERE rolname = 'agentify_privacy')]::oid[]
        AND pg_get_expr(policy.polqual, policy.polrelid) = 'true'
    ) THEN
      RAISE EXCEPTION 'Scanner privacy report identity policies missing: %', privacy_table;
    END IF;
    IF (SELECT count(*) FROM pg_policy WHERE polrelid = ('public.' || privacy_table)::regclass) <> 4 THEN
      RAISE EXCEPTION 'Unexpected scanner report identity policy set on %: % policies (%)',
        privacy_table,
        (SELECT count(*) FROM pg_policy WHERE polrelid = ('public.' || privacy_table)::regclass),
        (SELECT string_agg(polname, ', ' ORDER BY polname)
         FROM pg_policy WHERE polrelid = ('public.' || privacy_table)::regclass);
    END IF;
  END LOOP;

  IF has_table_privilege('agentify_privacy', 'public.scanner_identity_deletion_operations', 'SELECT')
     OR has_table_privilege('agentify_privacy', 'public.scanner_identity_deletion_operations', 'INSERT')
     OR has_table_privilege('agentify_privacy', 'public.scanner_identity_deletion_operations', 'UPDATE')
     OR has_table_privilege('agentify_privacy', 'public.scanner_identity_deletion_operations', 'DELETE')
     OR has_table_privilege('agentify_privacy', 'public.scanner_identity_deletion_operations', 'TRUNCATE')
     OR has_table_privilege('agentify_privacy', 'public.scanner_identity_deletion_operations', 'REFERENCES')
     OR has_table_privilege('agentify_privacy', 'public.scanner_identity_deletion_operations', 'TRIGGER') THEN
    RAISE EXCEPTION 'Privacy can access scanner identity deletion operations';
  END IF;
  IF (SELECT count(*) FROM pg_policy WHERE polrelid = 'public.scanner_identity_deletion_operations'::regclass) <> 2 THEN
    RAISE EXCEPTION 'Unexpected scanner identity deletion policy set';
  END IF;

  IF to_regclass('public.scanner_auth_users') IS NOT NULL
     OR to_regclass('public.scanner_auth_sessions') IS NOT NULL
     OR to_regclass('public.scanner_auth_accounts') IS NOT NULL
     OR to_regclass('public.scanner_auth_verifications') IS NOT NULL
     OR to_regclass('public.verification_tokens') IS NOT NULL
     OR EXISTS (
       SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'leads'
         AND column_name = 'scanner_auth_user_id'
     ) THEN
    RAISE EXCEPTION 'Retired scanner identity schema remains after cutover';
  END IF;
END
$scanner_report_identity_access$;
SQL

echo "Scanner report identity tables, RLS and role boundaries passed."
