CREATE TABLE "registration_intents" (
	"id" uuid PRIMARY KEY NOT NULL,
	"scan_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"callback_state_hash" text NOT NULL,
	"email_normalized_ciphertext" text NOT NULL,
	"email_lookup_hash" text NOT NULL,
	"phone_e164_ciphertext" text NOT NULL,
	"phone_lookup_hash" text NOT NULL,
	"role" text NOT NULL,
	"site_ownership_claim" boolean DEFAULT false NOT NULL,
	"marketing_email_opt_in" boolean DEFAULT false NOT NULL,
	"dataset_reuse_acknowledged" boolean DEFAULT false NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "registration_intents_id_uuidv7" CHECK (substring("registration_intents"."id"::text, 15, 1) = '7'),
	CONSTRAINT "registration_intents_dataset_acknowledged" CHECK ("registration_intents"."dataset_reuse_acknowledged" = true)
);
--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "supabase_user_id" uuid;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "phone_e164_ciphertext" text;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "phone_lookup_hash" text;--> statement-breakpoint
ALTER TABLE "registration_intents" ADD CONSTRAINT "registration_intents_scan_id_scans_id_fk" FOREIGN KEY ("scan_id") REFERENCES "public"."scans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "registration_intents" ADD CONSTRAINT "registration_intents_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "registration_intents_callback_state_uidx" ON "registration_intents" USING btree ("callback_state_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "registration_intents_active_scan_email_uidx" ON "registration_intents" USING btree ("scan_id","email_lookup_hash") WHERE "registration_intents"."consumed_at" is null;--> statement-breakpoint
CREATE INDEX "registration_intents_expiry_idx" ON "registration_intents" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "leads_supabase_user_id_uidx" ON "leads" USING btree ("supabase_user_id") WHERE "leads"."supabase_user_id" is not null;--> statement-breakpoint
ALTER TABLE "registration_intents" ENABLE ROW LEVEL SECURITY;
