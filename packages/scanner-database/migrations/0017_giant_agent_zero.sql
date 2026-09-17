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
