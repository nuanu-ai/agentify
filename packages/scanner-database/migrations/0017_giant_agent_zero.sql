DO $scanner_identity_cleanup_guard$
DECLARE authorized boolean := false;
DECLARE old_rows_exist boolean := false;
DECLARE marker_schema_valid boolean := false;
BEGIN
  IF to_regclass('public.scanner_identity_cutover_ready') IS NOT NULL THEN
    SELECT
      count(*) = 2
      AND bool_or(attname = 'id' AND atttypid = 'boolean'::regtype AND attnotnull)
      AND bool_or(attname = 'plan_digest' AND atttypid = 'text'::regtype AND attnotnull)
    INTO marker_schema_valid
    FROM pg_attribute
    WHERE attrelid = 'public.scanner_identity_cutover_ready'::regclass
      AND attnum > 0
      AND NOT attisdropped;
    marker_schema_valid := marker_schema_valid
      AND EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conrelid = 'public.scanner_identity_cutover_ready'::regclass
          AND contype = 'p'
          AND conkey = ARRAY[
            (
              SELECT attnum
              FROM pg_attribute
              WHERE attrelid = 'public.scanner_identity_cutover_ready'::regclass
                AND attname = 'id'
                AND NOT attisdropped
            )
          ]::smallint[]
      )
      AND EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conrelid = 'public.scanner_identity_cutover_ready'::regclass
          AND contype = 'c'
          AND pg_get_constraintdef(oid) ~ '^CHECK \(id\)$'
      )
      AND EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conrelid = 'public.scanner_identity_cutover_ready'::regclass
          AND contype = 'c'
          AND pg_get_constraintdef(oid) ~ '^CHECK \(\(length\(plan_digest\) = 64\)\)$'
      );
    IF NOT marker_schema_valid THEN
      RAISE EXCEPTION 'scanner_identity_cleanup_marker_invalid';
    END IF;
    SELECT count(*) = 1
      AND bool_and(id)
      AND bool_and(plan_digest ~ '^[a-f0-9]{64}$')
    INTO authorized
    FROM public.scanner_identity_cutover_ready;
    IF NOT authorized THEN
      RAISE EXCEPTION 'scanner_identity_cleanup_marker_invalid';
    END IF;
  END IF;

  SELECT
    EXISTS (SELECT 1 FROM public.scanner_auth_accounts)
    OR EXISTS (SELECT 1 FROM public.scanner_auth_sessions)
    OR EXISTS (SELECT 1 FROM public.scanner_auth_users)
    OR EXISTS (SELECT 1 FROM public.scanner_auth_verifications)
    OR EXISTS (SELECT 1 FROM public.verification_tokens)
    OR EXISTS (
      SELECT 1 FROM public.leads WHERE scanner_auth_user_id IS NOT NULL
    )
  INTO old_rows_exist;

  IF old_rows_exist AND NOT authorized THEN
    RAISE EXCEPTION 'scanner_identity_cleanup_requires_verified_cutover';
  END IF;
END
$scanner_identity_cleanup_guard$;
--> statement-breakpoint
DO $scanner_identity_dashboard_transition$
DECLARE view_columns text[];
DECLARE legacy_columns constant text[] := ARRAY[
	'overdue_recovery_intents',
	'overdue_unverified_leads',
	'expired_active_report_sessions',
	'active_public_shares',
	'attached_card_signals',
	'analytics_dead_letters'
];
DECLARE registration_second_columns constant text[] := ARRAY[
	'overdue_recovery_intents',
	'overdue_registration_intents',
	'overdue_unverified_leads',
	'expired_active_report_sessions',
	'active_public_shares',
	'attached_card_signals',
	'analytics_dead_letters'
];
DECLARE registration_last_columns constant text[] := ARRAY[
	'overdue_recovery_intents',
	'overdue_unverified_leads',
	'expired_active_report_sessions',
	'active_public_shares',
	'attached_card_signals',
	'analytics_dead_letters',
	'overdue_registration_intents'
];
DECLARE final_registration_second_columns constant text[] := registration_second_columns
	|| ARRAY['overdue_identity_completions'];
DECLARE final_registration_last_columns constant text[] := registration_last_columns
	|| ARRAY['overdue_identity_completions'];
BEGIN
	-- Existing installations may still have the dashboard view that reads the
	-- legacy verification_tokens table. Replace only that known view in place so
	-- its OID, owner and grants survive; databases without dashboards remain so.
	IF to_regclass('metabase.privacy_retention_audit') IS NOT NULL THEN
		IF EXISTS (
			SELECT 1 FROM information_schema.columns
			WHERE table_schema = 'metabase'
				AND table_name = 'privacy_retention_audit'
				AND column_name = 'overdue_verification_tokens'
		) THEN
			ALTER VIEW metabase.privacy_retention_audit
				RENAME COLUMN overdue_verification_tokens TO overdue_recovery_intents;
		END IF;

		SELECT array_agg(attribute.attname::text ORDER BY attribute.attnum)
		INTO view_columns
		FROM pg_class relation
		JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
		JOIN pg_attribute attribute ON attribute.attrelid = relation.oid
		WHERE namespace.nspname = 'metabase'
			AND relation.relname = 'privacy_retention_audit'
			AND relation.relkind = 'v'
			AND attribute.attnum > 0
			AND NOT attribute.attisdropped;

		IF view_columns = registration_second_columns
			OR view_columns = final_registration_second_columns
		THEN
			CREATE OR REPLACE VIEW metabase.privacy_retention_audit WITH (security_barrier = true) AS
			SELECT
				(SELECT count(*) FROM public.scanner_recovery_intents WHERE coalesce(consumed_at, expires_at) <= now() - interval '7 days') AS overdue_recovery_intents,
				(SELECT count(*) FROM public.registration_intents WHERE coalesce(consumed_at, expires_at) < now() - interval '7 days') AS overdue_registration_intents,
				(SELECT count(*) FROM public.leads WHERE verified_at IS NULL AND anonymized_at IS NULL AND created_at < now() - interval '30 days') AS overdue_unverified_leads,
				(SELECT count(*) FROM public.report_sessions WHERE expires_at < now() AND revoked_at IS NULL) AS expired_active_report_sessions,
				(SELECT count(*) FROM public.scan_shares WHERE status = 'published') AS active_public_shares,
				(SELECT count(*) FROM public.payment_signals WHERE status = 'attached') AS attached_card_signals,
				(SELECT count(*) FROM public.delivery_outbox WHERE status = 'dead_letter') AS analytics_dead_letters,
				(SELECT count(*) FROM public.scanner_identity_completions WHERE retain_until <= now()) AS overdue_identity_completions;
		ELSIF view_columns = legacy_columns
			OR view_columns = registration_last_columns
			OR view_columns = final_registration_last_columns
		THEN
			CREATE OR REPLACE VIEW metabase.privacy_retention_audit WITH (security_barrier = true) AS
			SELECT
				(SELECT count(*) FROM public.scanner_recovery_intents WHERE coalesce(consumed_at, expires_at) <= now() - interval '7 days') AS overdue_recovery_intents,
				(SELECT count(*) FROM public.leads WHERE verified_at IS NULL AND anonymized_at IS NULL AND created_at < now() - interval '30 days') AS overdue_unverified_leads,
				(SELECT count(*) FROM public.report_sessions WHERE expires_at < now() AND revoked_at IS NULL) AS expired_active_report_sessions,
				(SELECT count(*) FROM public.scan_shares WHERE status = 'published') AS active_public_shares,
				(SELECT count(*) FROM public.payment_signals WHERE status = 'attached') AS attached_card_signals,
				(SELECT count(*) FROM public.delivery_outbox WHERE status = 'dead_letter') AS analytics_dead_letters,
				(SELECT count(*) FROM public.registration_intents WHERE coalesce(consumed_at, expires_at) < now() - interval '7 days') AS overdue_registration_intents,
				(SELECT count(*) FROM public.scanner_identity_completions WHERE retain_until <= now()) AS overdue_identity_completions;
		ELSE
			RAISE EXCEPTION 'unexpected metabase.privacy_retention_audit columns: %', view_columns;
		END IF;
	END IF;
END
$scanner_identity_dashboard_transition$;
--> statement-breakpoint
DROP INDEX "registration_intents_active_scan_email_uidx";--> statement-breakpoint
ALTER TABLE "leads" DROP CONSTRAINT "leads_scanner_auth_user_id_scanner_auth_users_id_fk";
--> statement-breakpoint
DROP INDEX "leads_scanner_auth_user_id_uidx";--> statement-breakpoint
ALTER TABLE "leads" DROP COLUMN "scanner_auth_user_id";--> statement-breakpoint
DROP TABLE "scanner_auth_accounts";--> statement-breakpoint
DROP TABLE "scanner_auth_sessions";--> statement-breakpoint
DROP TABLE "scanner_auth_verifications";--> statement-breakpoint
DROP TABLE "scanner_auth_users";--> statement-breakpoint
DROP TABLE "verification_tokens";--> statement-breakpoint
DROP TABLE IF EXISTS "scanner_identity_cutover_ready";
