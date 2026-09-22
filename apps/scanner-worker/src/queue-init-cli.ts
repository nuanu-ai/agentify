import { createDatabase, normalizeNodePostgresConnectionString } from "@agentify/scanner-database";
import { PgBoss } from "pg-boss";
import { z } from "zod";

const { DATABASE_URL } = z
  .object({ DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }) })
  .parse(process.env);

const boss = new PgBoss({
  connectionString: normalizeNodePostgresConnectionString(DATABASE_URL),
  schema: "pgboss",
  application_name: "agentify-queue-bootstrap",
});

await boss.start();
try {
  await boss.createQueue("scan-v1", {
    retryLimit: 1,
    retryDelay: 1,
    expireInSeconds: 60,
  });
  await boss.createQueue("browser-observation-v1", {
    retryLimit: 0,
    expireInSeconds: 90,
  });
} finally {
  await boss.stop({ graceful: true, timeout: 10_000 });
}

const { pool } = createDatabase(DATABASE_URL, { max: 1 });
try {
  await pool.query(`
    ALTER DEFAULT PRIVILEGES IN SCHEMA public
      REVOKE ALL ON TABLES FROM agentify_web;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public
      REVOKE ALL ON SEQUENCES FROM agentify_web;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public
      REVOKE ALL ON FUNCTIONS FROM agentify_web;

    ALTER DEFAULT PRIVILEGES IN SCHEMA public
      REVOKE ALL ON TABLES FROM PUBLIC;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public
      REVOKE ALL ON SEQUENCES FROM PUBLIC;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public
      REVOKE ALL ON FUNCTIONS FROM PUBLIC;
    ALTER DEFAULT PRIVILEGES IN SCHEMA pgboss
      REVOKE ALL ON TABLES FROM PUBLIC;
    ALTER DEFAULT PRIVILEGES IN SCHEMA pgboss
      REVOKE ALL ON SEQUENCES FROM PUBLIC;
    ALTER DEFAULT PRIVILEGES IN SCHEMA pgboss
      REVOKE ALL ON FUNCTIONS FROM PUBLIC;

    DO $supabase_public_roles$
    DECLARE role_name text;
    BEGIN
      FOREACH role_name IN ARRAY ARRAY['anon', 'authenticated', 'service_role']
      LOOP
        IF EXISTS (SELECT 1 FROM pg_roles r WHERE r.rolname = role_name) THEN
          EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM %I', role_name);
          EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM %I', role_name);
          EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM %I', role_name);
          EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA pgboss REVOKE ALL ON TABLES FROM %I', role_name);
          EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA pgboss REVOKE ALL ON SEQUENCES FROM %I', role_name);
          EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA pgboss REVOKE ALL ON FUNCTIONS FROM %I', role_name);
          EXECUTE format('REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public, pgboss FROM %I', role_name);
          EXECUTE format('REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public, pgboss FROM %I', role_name);
          EXECUTE format('REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA public, pgboss FROM %I', role_name);
        END IF;
      END LOOP;
    END
    $supabase_public_roles$;

    GRANT USAGE ON SCHEMA public TO agentify_web, agentify_worker, agentify_privacy;
    GRANT USAGE ON SCHEMA pgboss TO agentify_web, agentify_worker;

    REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public, pgboss
      FROM agentify_web, agentify_worker, agentify_privacy;
    REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public, pgboss
      FROM agentify_web, agentify_worker, agentify_privacy;
    REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public, pgboss FROM PUBLIC;
    REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public, pgboss FROM PUBLIC;
    REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA public, pgboss FROM PUBLIC;

    GRANT SELECT, INSERT, UPDATE ON public.analytics_events TO agentify_web;
    GRANT SELECT, INSERT ON public.consent_snapshots TO agentify_web;
    GRANT SELECT, INSERT, DELETE ON public.delivery_outbox TO agentify_web;
    GRANT SELECT, INSERT, UPDATE, DELETE ON public.lead_scans, public.leads,
      public.payment_signals, public.report_sessions,
      public.registration_intents, public.scan_shares, public.scans,
      public.sessions,
      public.waitlist_entries, public.webhook_receipts TO agentify_web;
    GRANT SELECT, INSERT ON public.rate_limit_events TO agentify_web;
    GRANT SELECT, INSERT, UPDATE ON public.rate_windows TO agentify_web;
    GRANT SELECT ON public.browser_observations,
      public.browser_observation_findings TO agentify_web;
    GRANT SELECT, UPDATE ON public.scan_checks TO agentify_web;
    GRANT SELECT ON public.scan_fingerprints, public.worker_heartbeats TO agentify_web;
    GRANT SELECT, DELETE ON public.scan_snapshots TO agentify_web;
    GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO agentify_web;

    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public
      TO agentify_privacy;
    GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public
      TO agentify_privacy;

    DO $scanner_identity_grants$
    DECLARE table_name text;
    DECLARE role_name text;
    BEGIN
      FOREACH table_name IN ARRAY ARRAY[
        'scanner_recovery_intents', 'scanner_identity_completions'
      ] LOOP
        IF to_regclass(format('public.%I', table_name)) IS NOT NULL THEN
          EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON public.%I TO agentify_web', table_name);
          EXECUTE format('REVOKE ALL ON public.%I FROM agentify_privacy', table_name);
          EXECUTE format('GRANT SELECT, DELETE ON public.%I TO agentify_privacy', table_name);
          FOREACH role_name IN ARRAY ARRAY['agentify_worker', 'agentify_dashboard'] LOOP
            IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
              EXECUTE format('REVOKE ALL ON public.%I FROM %I', table_name, role_name);
            END IF;
          END LOOP;
        END IF;
      END LOOP;
      IF to_regclass('public.scanner_identity_deletion_operations') IS NOT NULL THEN
        GRANT SELECT, INSERT, UPDATE, DELETE
          ON public.scanner_identity_deletion_operations TO agentify_web;
        REVOKE ALL ON public.scanner_identity_deletion_operations
          FROM agentify_privacy, agentify_worker, agentify_dashboard;
      END IF;
    END
    $scanner_identity_grants$;

    GRANT SELECT, UPDATE ON public.scans TO agentify_worker;
    GRANT SELECT, INSERT, UPDATE, DELETE ON public.scan_checks TO agentify_worker;
    GRANT SELECT, INSERT, UPDATE ON public.scan_fingerprints TO agentify_worker;
    GRANT SELECT, INSERT ON public.scan_snapshots TO agentify_worker;
    GRANT SELECT ON public.sessions, public.consent_snapshots TO agentify_worker;
    GRANT SELECT, INSERT ON public.analytics_events TO agentify_worker;
    GRANT SELECT, INSERT, UPDATE ON public.delivery_outbox TO agentify_worker;
    GRANT SELECT, INSERT, UPDATE ON public.worker_heartbeats TO agentify_worker;
    GRANT SELECT, INSERT, UPDATE, DELETE ON public.browser_observations,
      public.browser_observation_findings,
      public.browser_observation_budget_days TO agentify_worker;

    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA pgboss
      TO agentify_web, agentify_worker;
    GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA pgboss
      TO agentify_web, agentify_worker;
    GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA pgboss
      TO agentify_web, agentify_worker;

    DO $policies$
    DECLARE row record;
    BEGIN
      FOR row IN
        SELECT n.nspname AS schema_name, c.relname AS table_name
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relrowsecurity
      LOOP
        EXECUTE format('DROP POLICY IF EXISTS agentify_web_service ON %I.%I', row.schema_name, row.table_name);
        EXECUTE format('CREATE POLICY agentify_web_service ON %I.%I TO agentify_web USING (true) WITH CHECK (true)', row.schema_name, row.table_name);
      END LOOP;

      FOR row IN
        SELECT n.nspname AS schema_name, c.relname AS table_name
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relrowsecurity
      LOOP
        EXECUTE format('DROP POLICY IF EXISTS agentify_privacy_service ON %I.%I', row.schema_name, row.table_name);
        IF row.table_name <> ALL (ARRAY[
          'scanner_recovery_intents', 'scanner_identity_completions',
          'scanner_identity_deletion_operations'
        ]) THEN
          EXECUTE format('CREATE POLICY agentify_privacy_service ON %I.%I TO agentify_privacy USING (true) WITH CHECK (true)', row.schema_name, row.table_name);
        END IF;
      END LOOP;

      FOR row IN
        SELECT n.nspname AS schema_name, c.relname AS table_name
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public'
          AND c.relrowsecurity
          AND c.relname = ANY (ARRAY[
            'scans', 'scan_checks', 'scan_fingerprints', 'scan_snapshots',
            'sessions', 'consent_snapshots', 'analytics_events',
            'delivery_outbox', 'worker_heartbeats', 'browser_observations',
            'browser_observation_findings', 'browser_observation_budget_days'
          ])
      LOOP
        EXECUTE format('DROP POLICY IF EXISTS agentify_worker_service ON %I.%I', row.schema_name, row.table_name);
        EXECUTE format('CREATE POLICY agentify_worker_service ON %I.%I TO agentify_worker USING (true) WITH CHECK (true)', row.schema_name, row.table_name);
      END LOOP;
    END
    $policies$;

    ALTER DEFAULT PRIVILEGES IN SCHEMA pgboss
      GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO agentify_web, agentify_worker;
    ALTER DEFAULT PRIVILEGES IN SCHEMA pgboss
      GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO agentify_web, agentify_worker;
    ALTER DEFAULT PRIVILEGES IN SCHEMA pgboss
      GRANT EXECUTE ON FUNCTIONS TO agentify_web, agentify_worker;
  `);
  process.stdout.write("Queue schema and runtime grants prepared successfully.\n");
} finally {
  await pool.end();
}
