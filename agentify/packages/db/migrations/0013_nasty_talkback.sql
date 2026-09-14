CREATE TABLE "merchant_applications" (
	"id" uuid PRIMARY KEY NOT NULL,
	"idempotency_key_hash" text NOT NULL,
	"request_hash" text NOT NULL,
	"payload_ciphertext" text NOT NULL,
	"policy_version" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "merchant_applications_id_uuidv7" CHECK (substring("merchant_applications"."id"::text, 15, 1) = '7')
);
--> statement-breakpoint
CREATE UNIQUE INDEX "merchant_applications_idempotency_uidx" ON "merchant_applications" USING btree ("idempotency_key_hash");--> statement-breakpoint
CREATE INDEX "merchant_applications_expiry_idx" ON "merchant_applications" USING btree ("expires_at");--> statement-breakpoint
ALTER TABLE "merchant_applications" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON TABLE "merchant_applications" FROM PUBLIC;
--> statement-breakpoint
DO $merchant_access$
DECLARE role_name text;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['anon','authenticated','service_role','agentify_worker','agentify_dashboard'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
      EXECUTE format('REVOKE ALL ON TABLE public.merchant_applications FROM %I', role_name);
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'agentify_web') THEN
    GRANT SELECT, INSERT ON public.merchant_applications TO agentify_web;
    CREATE POLICY merchant_web_select ON public.merchant_applications FOR SELECT TO agentify_web USING (true);
    CREATE POLICY merchant_web_insert ON public.merchant_applications FOR INSERT TO agentify_web WITH CHECK (true);
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'agentify_privacy') THEN
    GRANT SELECT, DELETE ON public.merchant_applications TO agentify_privacy;
    CREATE POLICY merchant_privacy_select ON public.merchant_applications FOR SELECT TO agentify_privacy USING (true);
    CREATE POLICY merchant_privacy_delete ON public.merchant_applications FOR DELETE TO agentify_privacy USING (true);
  END IF;
END
$merchant_access$;
