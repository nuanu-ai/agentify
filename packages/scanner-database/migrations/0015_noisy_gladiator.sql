CREATE TABLE "scanner_auth_accounts" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"account_id" text NOT NULL,
	"issuer" text NOT NULL,
	"password" text,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp with time zone,
	"refresh_token_expires_at" timestamp with time zone,
	"scope" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "scanner_auth_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"token" text NOT NULL,
	"user_id" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ip_address" text,
	"user_agent" text,
	CONSTRAINT "scanner_auth_sessions_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "scanner_auth_users" (
	"id" text PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"name" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "scanner_auth_users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "scanner_auth_verifications" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "scanner_auth_user_id" text;--> statement-breakpoint
ALTER TABLE "scanner_auth_accounts" ADD CONSTRAINT "scanner_auth_accounts_user_id_scanner_auth_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."scanner_auth_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scanner_auth_sessions" ADD CONSTRAINT "scanner_auth_sessions_user_id_scanner_auth_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."scanner_auth_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "scanner_auth_accounts_user_idx" ON "scanner_auth_accounts" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "scanner_auth_sessions_user_idx" ON "scanner_auth_sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "scanner_auth_sessions_expires_idx" ON "scanner_auth_sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "scanner_auth_verifications_identifier_idx" ON "scanner_auth_verifications" USING btree ("identifier");--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_scanner_auth_user_id_scanner_auth_users_id_fk" FOREIGN KEY ("scanner_auth_user_id") REFERENCES "public"."scanner_auth_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "leads_scanner_auth_user_id_uidx" ON "leads" USING btree ("scanner_auth_user_id") WHERE "leads"."scanner_auth_user_id" is not null;--> statement-breakpoint
-- Scanner identity is private to scanner web and privacy cleanup. Workers and
-- commerce cabinet accounts never receive an identity grant.
DO $scanner_identity_access$
DECLARE table_name text;
DECLARE role_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'scanner_auth_users', 'scanner_auth_sessions',
    'scanner_auth_accounts', 'scanner_auth_verifications'
  ] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC', table_name);
    FOREACH role_name IN ARRAY ARRAY[
      'anon', 'authenticated', 'service_role',
      'agentify_worker', 'agentify_dashboard'
    ] LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
        EXECUTE format('REVOKE ALL ON TABLE public.%I FROM %I', table_name, role_name);
      END IF;
    END LOOP;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'agentify_web') THEN
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.%I TO agentify_web', table_name);
      EXECUTE format('CREATE POLICY scanner_identity_web ON public.%I FOR ALL TO agentify_web USING (true) WITH CHECK (true)', table_name);
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'agentify_privacy') THEN
      EXECUTE format('GRANT SELECT, DELETE ON TABLE public.%I TO agentify_privacy', table_name);
      EXECUTE format('CREATE POLICY scanner_identity_privacy_select ON public.%I FOR SELECT TO agentify_privacy USING (true)', table_name);
      EXECUTE format('CREATE POLICY scanner_identity_privacy_delete ON public.%I FOR DELETE TO agentify_privacy USING (true)', table_name);
    END IF;
  END LOOP;
END
$scanner_identity_access$;
