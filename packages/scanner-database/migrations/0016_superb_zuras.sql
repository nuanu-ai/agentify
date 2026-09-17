CREATE TABLE "scanner_identity_completions" (
	"receipt_id" uuid PRIMARY KEY NOT NULL,
	"token_hash" text NOT NULL,
	"intent_kind" text NOT NULL,
	"state_hash" text NOT NULL,
	"lead_id" uuid NOT NULL,
	"scan_id" uuid NOT NULL,
	"completed_at" timestamp with time zone NOT NULL,
	"retain_until" timestamp with time zone NOT NULL,
	CONSTRAINT "scanner_identity_completions_token_hash_format" CHECK ("scanner_identity_completions"."token_hash" ~ '^[A-Za-z0-9_-]{43}$'),
	CONSTRAINT "scanner_identity_completions_state_hash_format" CHECK ("scanner_identity_completions"."state_hash" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "scanner_identity_completions_intent_kind" CHECK ("scanner_identity_completions"."intent_kind" in ('registration', 'recovery'))
);
--> statement-breakpoint
CREATE TABLE "scanner_identity_deletion_operations" (
	"operation_id" uuid PRIMARY KEY NOT NULL,
	"lead_id" uuid NOT NULL,
	"cabinet_result" text,
	"lease_token" uuid,
	"lease_expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "scanner_identity_deletion_operations_id_uuidv7" CHECK (substring("scanner_identity_deletion_operations"."operation_id"::text, 15, 1) = '7'),
	CONSTRAINT "scanner_identity_deletion_operations_result" CHECK ("scanner_identity_deletion_operations"."cabinet_result" is null or "scanner_identity_deletion_operations"."cabinet_result" in ('deleted', 'already_absent', 'retained')),
	CONSTRAINT "scanner_identity_deletion_operations_completion" CHECK ("scanner_identity_deletion_operations"."completed_at" is null or "scanner_identity_deletion_operations"."cabinet_result" is not null)
);
--> statement-breakpoint
CREATE TABLE "scanner_recovery_intents" (
	"id" uuid PRIMARY KEY NOT NULL,
	"token_hash" text,
	"state_hash" text NOT NULL,
	"email_lookup_hash" text NOT NULL,
	"lead_id" uuid NOT NULL,
	"scan_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"activated_at" timestamp with time zone,
	"consumed_at" timestamp with time zone,
	CONSTRAINT "scanner_recovery_intents_token_hash_format" CHECK ("scanner_recovery_intents"."token_hash" is null or "scanner_recovery_intents"."token_hash" ~ '^[A-Za-z0-9_-]{43}$'),
	CONSTRAINT "scanner_recovery_intents_state_hash_format" CHECK ("scanner_recovery_intents"."state_hash" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "scanner_recovery_intents_activation" CHECK (("scanner_recovery_intents"."token_hash" is null and "scanner_recovery_intents"."activated_at" is null and "scanner_recovery_intents"."consumed_at" is null) or ("scanner_recovery_intents"."token_hash" is not null and "scanner_recovery_intents"."activated_at" is not null))
);
--> statement-breakpoint
ALTER TABLE "scanner_identity_completions" ADD CONSTRAINT "scanner_identity_completions_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scanner_identity_completions" ADD CONSTRAINT "scanner_identity_completions_scan_id_scans_id_fk" FOREIGN KEY ("scan_id") REFERENCES "public"."scans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scanner_identity_deletion_operations" ADD CONSTRAINT "scanner_identity_deletion_operations_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scanner_recovery_intents" ADD CONSTRAINT "scanner_recovery_intents_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scanner_recovery_intents" ADD CONSTRAINT "scanner_recovery_intents_scan_id_scans_id_fk" FOREIGN KEY ("scan_id") REFERENCES "public"."scans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "scanner_identity_completions_token_hash_uidx" ON "scanner_identity_completions" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "scanner_identity_completions_retention_idx" ON "scanner_identity_completions" USING btree ("retain_until");--> statement-breakpoint
CREATE UNIQUE INDEX "scanner_identity_deletion_operations_lead_uidx" ON "scanner_identity_deletion_operations" USING btree ("lead_id");--> statement-breakpoint
CREATE INDEX "scanner_identity_deletion_operations_pending_idx" ON "scanner_identity_deletion_operations" USING btree ("lease_expires_at","created_at") WHERE "scanner_identity_deletion_operations"."completed_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "scanner_recovery_intents_token_hash_uidx" ON "scanner_recovery_intents" USING btree ("token_hash") WHERE "scanner_recovery_intents"."token_hash" is not null;--> statement-breakpoint
CREATE INDEX "scanner_recovery_intents_state_hash_idx" ON "scanner_recovery_intents" USING btree ("state_hash");--> statement-breakpoint
CREATE INDEX "scanner_recovery_intents_expiry_idx" ON "scanner_recovery_intents" USING btree ("expires_at");
--> statement-breakpoint
DO $scanner_report_identity_access$
DECLARE table_name text;
DECLARE role_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'scanner_recovery_intents',
    'scanner_identity_completions',
    'scanner_identity_deletion_operations'
  ] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC', table_name);
    FOREACH role_name IN ARRAY ARRAY[
      'anon', 'authenticated', 'service_role',
      'agentify_privacy', 'agentify_worker', 'agentify_dashboard'
    ] LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
        EXECUTE format('REVOKE ALL ON TABLE public.%I FROM %I', table_name, role_name);
      END IF;
    END LOOP;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'agentify_web') THEN
      EXECUTE format(
        'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.%I TO agentify_web',
        table_name
      );
      EXECUTE format(
        'CREATE POLICY scanner_report_identity_web ON public.%I FOR ALL TO agentify_web USING (true) WITH CHECK (true)',
        table_name
      );
    END IF;
  END LOOP;

  FOREACH table_name IN ARRAY ARRAY[
    'scanner_recovery_intents',
    'scanner_identity_completions'
  ] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'agentify_privacy') THEN
      EXECUTE format(
        'GRANT SELECT, DELETE ON TABLE public.%I TO agentify_privacy',
        table_name
      );
      EXECUTE format(
        'CREATE POLICY scanner_report_identity_privacy_select ON public.%I FOR SELECT TO agentify_privacy USING (true)',
        table_name
      );
      EXECUTE format(
        'CREATE POLICY scanner_report_identity_privacy_delete ON public.%I FOR DELETE TO agentify_privacy USING (true)',
        table_name
      );
    END IF;
  END LOOP;
END
$scanner_report_identity_access$;
