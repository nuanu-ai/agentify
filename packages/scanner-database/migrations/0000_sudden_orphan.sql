CREATE TYPE "public"."check_status" AS ENUM('pending', 'running', 'pass', 'partial', 'fail', 'unavailable', 'not_applicable');--> statement-breakpoint
CREATE TYPE "public"."delivery_destination" AS ENUM('posthog', 'meta');--> statement-breakpoint
CREATE TYPE "public"."diagnostic_level" AS ENUM('invisible', 'readable', 'callable_ready', 'ahead_of_market', 'incomplete');--> statement-breakpoint
CREATE TYPE "public"."outbox_status" AS ENUM('pending', 'processing', 'delivered', 'dead_letter');--> statement-breakpoint
CREATE TYPE "public"."payment_signal_status" AS ENUM('not_started', 'setup_pending', 'attached', 'detached', 'failed');--> statement-breakpoint
CREATE TYPE "public"."scan_status" AS ENUM('accepted', 'queued', 'running', 'completed', 'partial', 'failed');--> statement-breakpoint
CREATE TYPE "public"."segment" AS ENUM('store', 'owner', 'local');--> statement-breakpoint
CREATE TYPE "public"."share_status" AS ENUM('published', 'revoked');--> statement-breakpoint
CREATE TYPE "public"."webhook_receipt_status" AS ENUM('received', 'processed', 'failed');--> statement-breakpoint
CREATE TABLE "analytics_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"event_id" uuid NOT NULL,
	"name" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"session_id" uuid NOT NULL,
	"lead_id" uuid,
	"scan_id" uuid,
	"segment" "segment" NOT NULL,
	"landing_variant" text NOT NULL,
	"properties" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"consent_snapshot_id" uuid NOT NULL,
	CONSTRAINT "analytics_events_id_uuidv7" CHECK (substring("analytics_events"."id"::text, 15, 1) = '7'),
	CONSTRAINT "analytics_events_event_id_uuidv7" CHECK (substring("analytics_events"."event_id"::text, 15, 1) = '7')
);
--> statement-breakpoint
CREATE TABLE "consent_snapshots" (
	"id" uuid PRIMARY KEY NOT NULL,
	"session_id" uuid NOT NULL,
	"policy_version" text NOT NULL,
	"country" text,
	"categories" jsonb NOT NULL,
	"captured_at" timestamp with time zone DEFAULT now() NOT NULL,
	"source" text NOT NULL,
	CONSTRAINT "consent_snapshots_id_uuidv7" CHECK (substring("consent_snapshots"."id"::text, 15, 1) = '7')
);
--> statement-breakpoint
CREATE TABLE "delivery_outbox" (
	"id" uuid PRIMARY KEY NOT NULL,
	"event_id" uuid NOT NULL,
	"destination" "delivery_destination" NOT NULL,
	"payload" jsonb NOT NULL,
	"status" "outbox_status" DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_error_code" text,
	CONSTRAINT "delivery_outbox_id_uuidv7" CHECK (substring("delivery_outbox"."id"::text, 15, 1) = '7'),
	CONSTRAINT "delivery_outbox_attempts_nonnegative" CHECK ("delivery_outbox"."attempts" >= 0)
);
--> statement-breakpoint
CREATE TABLE "lead_scans" (
	"lead_id" uuid NOT NULL,
	"scan_id" uuid NOT NULL,
	"site_ownership_claim" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "lead_scans_lead_id_scan_id_pk" PRIMARY KEY("lead_id","scan_id")
);
--> statement-breakpoint
CREATE TABLE "leads" (
	"id" uuid PRIMARY KEY NOT NULL,
	"email_normalized_ciphertext" text NOT NULL,
	"email_lookup_hash" text NOT NULL,
	"role" text NOT NULL,
	"name" text,
	"volume_bucket" text,
	"verified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"unsubscribed_at" timestamp with time zone,
	"first_segment" "segment" NOT NULL,
	"first_session_id" uuid NOT NULL,
	CONSTRAINT "leads_id_uuidv7" CHECK (substring("leads"."id"::text, 15, 1) = '7')
);
--> statement-breakpoint
CREATE TABLE "payment_signals" (
	"id" uuid PRIMARY KEY NOT NULL,
	"lead_id" uuid NOT NULL,
	"stripe_customer_id" text NOT NULL,
	"setup_intent_id" text NOT NULL,
	"payment_method_id_ciphertext" text,
	"status" "payment_signal_status" DEFAULT 'not_started' NOT NULL,
	"attached_at" timestamp with time zone,
	"detached_at" timestamp with time zone,
	"consent_snapshot_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_signals_id_uuidv7" CHECK (substring("payment_signals"."id"::text, 15, 1) = '7')
);
--> statement-breakpoint
CREATE TABLE "rate_windows" (
	"key_hash" text NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"kind" text NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	"challenge_passed_count" integer DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "rate_windows_key_hash_window_start_kind_pk" PRIMARY KEY("key_hash","window_start","kind"),
	CONSTRAINT "rate_windows_count_nonnegative" CHECK ("rate_windows"."count" >= 0),
	CONSTRAINT "rate_windows_challenge_count_nonnegative" CHECK ("rate_windows"."challenge_passed_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "report_sessions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"lead_id" uuid NOT NULL,
	"session_token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "report_sessions_id_uuidv7" CHECK (substring("report_sessions"."id"::text, 15, 1) = '7')
);
--> statement-breakpoint
CREATE TABLE "scan_checks" (
	"scan_id" uuid NOT NULL,
	"check_id" smallint NOT NULL,
	"status" "check_status" DEFAULT 'pending' NOT NULL,
	"nominal_weight" numeric(7, 3) NOT NULL,
	"applicable_weight" numeric(7, 3) NOT NULL,
	"earned_weight" numeric(7, 3) NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"summary_code" text,
	"evidence" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"error_code" text,
	CONSTRAINT "scan_checks_scan_id_check_id_pk" PRIMARY KEY("scan_id","check_id"),
	CONSTRAINT "scan_checks_id_range" CHECK ("scan_checks"."check_id" between 1 and 18)
);
--> statement-breakpoint
CREATE TABLE "scan_fingerprints" (
	"scan_id" uuid PRIMARY KEY NOT NULL,
	"platform" text NOT NULL,
	"platform_confidence" text NOT NULL,
	"cms_version" text,
	"version_confidence" text,
	"waf_cdn" text[] DEFAULT '{}'::text[] NOT NULL,
	"psp_markers" text[] DEFAULT '{}'::text[] NOT NULL,
	"feed_signals" text[] DEFAULT '{}'::text[] NOT NULL,
	"header_signals" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"html_signals" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"detector_version" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "scan_shares" (
	"id" uuid PRIMARY KEY NOT NULL,
	"scan_id" uuid NOT NULL,
	"share_slug_hash" text NOT NULL,
	"status" "share_status" DEFAULT 'published' NOT NULL,
	"published_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	"allow_indexing" boolean DEFAULT false NOT NULL,
	"public_snapshot" jsonb NOT NULL,
	CONSTRAINT "scan_shares_id_uuidv7" CHECK (substring("scan_shares"."id"::text, 15, 1) = '7')
);
--> statement-breakpoint
CREATE TABLE "scan_snapshots" (
	"id" uuid PRIMARY KEY NOT NULL,
	"cache_key" text NOT NULL,
	"rubric_version" text NOT NULL,
	"segment_profile" text NOT NULL,
	"canonical_target_url" text NOT NULL,
	"checks" jsonb NOT NULL,
	"fingerprint" jsonb NOT NULL,
	"score" smallint NOT NULL,
	"coverage" numeric(4, 3) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"invalidated_at" timestamp with time zone,
	CONSTRAINT "scan_snapshots_id_uuidv7" CHECK (substring("scan_snapshots"."id"::text, 15, 1) = '7'),
	CONSTRAINT "scan_snapshots_score_range" CHECK ("scan_snapshots"."score" between 0 and 100),
	CONSTRAINT "scan_snapshots_coverage_range" CHECK ("scan_snapshots"."coverage" between 0 and 1)
);
--> statement-breakpoint
CREATE TABLE "scans" (
	"id" uuid PRIMARY KEY NOT NULL,
	"session_id" uuid NOT NULL,
	"lead_id" uuid,
	"segment" "segment" NOT NULL,
	"rubric_version" text NOT NULL,
	"submitted_url_redacted" text NOT NULL,
	"canonical_target_url" text NOT NULL,
	"target_host" text NOT NULL,
	"target_hash" text NOT NULL,
	"status" "scan_status" DEFAULT 'accepted' NOT NULL,
	"attempt_no" smallint DEFAULT 1 NOT NULL,
	"accepted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"queued_at" timestamp with time zone,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"score" smallint,
	"coverage" numeric(4, 3),
	"level" "diagnostic_level",
	"applicable_weight" numeric(7, 3),
	"earned_weight" numeric(7, 3),
	"cache_hit" boolean DEFAULT false NOT NULL,
	"source_scan_id" uuid,
	"failure_code" text,
	"access_token_hash" text NOT NULL,
	"access_token_expires_at" timestamp with time zone NOT NULL,
	"idempotency_key_hash" text NOT NULL,
	CONSTRAINT "scans_id_uuidv7" CHECK (substring("scans"."id"::text, 15, 1) = '7'),
	CONSTRAINT "scans_score_range" CHECK ("scans"."score" is null or "scans"."score" between 0 and 100),
	CONSTRAINT "scans_coverage_range" CHECK ("scans"."coverage" is null or "scans"."coverage" between 0 and 1),
	CONSTRAINT "scans_attempt_range" CHECK ("scans"."attempt_no" between 1 and 2),
	CONSTRAINT "scans_terminal_result_invariant" CHECK (("scans"."status" not in ('completed', 'partial')) or ("scans"."score" is not null and "scans"."coverage" is not null and "scans"."finished_at" is not null)),
	CONSTRAINT "scans_completed_coverage_invariant" CHECK ("scans"."status" <> 'completed' or "scans"."coverage" = 1.000),
	CONSTRAINT "scans_partial_coverage_invariant" CHECK ("scans"."status" <> 'partial' or ("scans"."coverage" >= 0.300 and "scans"."coverage" < 1.000)),
	CONSTRAINT "scans_failed_level_invariant" CHECK ("scans"."status" <> 'failed' or ("scans"."score" is null and ("scans"."level" is null or "scans"."level" = 'incomplete')))
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"anonymous_id_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"first_landing_variant" text,
	"first_utm_source" text,
	"first_utm_medium" text,
	"first_utm_campaign" text,
	"first_utm_content" text,
	"first_utm_term" text,
	"first_fbclid_hash" text,
	"last_landing_variant" text,
	"last_utm_source" text,
	"last_utm_medium" text,
	"last_utm_campaign" text,
	"last_utm_content" text,
	"last_utm_term" text,
	"last_fbclid_hash" text,
	"geo_country" text,
	"consent_snapshot_id" uuid,
	CONSTRAINT "sessions_id_uuidv7" CHECK (substring("sessions"."id"::text, 15, 1) = '7')
);
--> statement-breakpoint
CREATE TABLE "verification_tokens" (
	"id" uuid PRIMARY KEY NOT NULL,
	"lead_id" uuid NOT NULL,
	"scan_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "verification_tokens_id_uuidv7" CHECK (substring("verification_tokens"."id"::text, 15, 1) = '7')
);
--> statement-breakpoint
CREATE TABLE "waitlist_entries" (
	"id" uuid PRIMARY KEY NOT NULL,
	"lead_id" uuid NOT NULL,
	"scan_id" uuid NOT NULL,
	"position" bigserial NOT NULL,
	"pain_answer" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"answered_at" timestamp with time zone,
	CONSTRAINT "waitlist_entries_id_uuidv7" CHECK (substring("waitlist_entries"."id"::text, 15, 1) = '7'),
	CONSTRAINT "waitlist_entries_answer_length" CHECK ("waitlist_entries"."pain_answer" is null or char_length("waitlist_entries"."pain_answer") between 10 and 2000)
);
--> statement-breakpoint
CREATE TABLE "webhook_receipts" (
	"provider" text NOT NULL,
	"provider_event_id" text NOT NULL,
	"payload_hash" text NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	"status" "webhook_receipt_status" DEFAULT 'received' NOT NULL,
	CONSTRAINT "webhook_receipts_provider_provider_event_id_pk" PRIMARY KEY("provider","provider_event_id")
);
--> statement-breakpoint
CREATE TABLE "worker_heartbeats" (
	"worker_id" text PRIMARY KEY NOT NULL,
	"service" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"heartbeat_at" timestamp with time zone NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
ALTER TABLE "analytics_events" ADD CONSTRAINT "analytics_events_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analytics_events" ADD CONSTRAINT "analytics_events_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analytics_events" ADD CONSTRAINT "analytics_events_scan_id_scans_id_fk" FOREIGN KEY ("scan_id") REFERENCES "public"."scans"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analytics_events" ADD CONSTRAINT "analytics_events_consent_snapshot_id_consent_snapshots_id_fk" FOREIGN KEY ("consent_snapshot_id") REFERENCES "public"."consent_snapshots"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consent_snapshots" ADD CONSTRAINT "consent_snapshots_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "analytics_events_event_id_uidx" ON "analytics_events" USING btree ("event_id");--> statement-breakpoint
ALTER TABLE "delivery_outbox" ADD CONSTRAINT "delivery_outbox_event_id_analytics_events_event_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."analytics_events"("event_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_scans" ADD CONSTRAINT "lead_scans_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_scans" ADD CONSTRAINT "lead_scans_scan_id_scans_id_fk" FOREIGN KEY ("scan_id") REFERENCES "public"."scans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_first_session_id_sessions_id_fk" FOREIGN KEY ("first_session_id") REFERENCES "public"."sessions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_signals" ADD CONSTRAINT "payment_signals_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_signals" ADD CONSTRAINT "payment_signals_consent_snapshot_id_consent_snapshots_id_fk" FOREIGN KEY ("consent_snapshot_id") REFERENCES "public"."consent_snapshots"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_sessions" ADD CONSTRAINT "report_sessions_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scan_checks" ADD CONSTRAINT "scan_checks_scan_id_scans_id_fk" FOREIGN KEY ("scan_id") REFERENCES "public"."scans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scan_fingerprints" ADD CONSTRAINT "scan_fingerprints_scan_id_scans_id_fk" FOREIGN KEY ("scan_id") REFERENCES "public"."scans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scan_shares" ADD CONSTRAINT "scan_shares_scan_id_scans_id_fk" FOREIGN KEY ("scan_id") REFERENCES "public"."scans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scans" ADD CONSTRAINT "scans_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scans" ADD CONSTRAINT "scans_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scans" ADD CONSTRAINT "scans_source_scan_id_scans_id_fk" FOREIGN KEY ("source_scan_id") REFERENCES "public"."scans"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verification_tokens" ADD CONSTRAINT "verification_tokens_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verification_tokens" ADD CONSTRAINT "verification_tokens_scan_id_scans_id_fk" FOREIGN KEY ("scan_id") REFERENCES "public"."scans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waitlist_entries" ADD CONSTRAINT "waitlist_entries_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waitlist_entries" ADD CONSTRAINT "waitlist_entries_scan_id_scans_id_fk" FOREIGN KEY ("scan_id") REFERENCES "public"."scans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "analytics_events_registration_business_uidx" ON "analytics_events" USING btree ("lead_id","scan_id","name") WHERE "analytics_events"."name" = 'registration_completed';--> statement-breakpoint
CREATE INDEX "analytics_events_name_occurred_idx" ON "analytics_events" USING btree ("name","occurred_at");--> statement-breakpoint
CREATE INDEX "analytics_events_segment_name_occurred_idx" ON "analytics_events" USING btree ("segment","name","occurred_at");--> statement-breakpoint
CREATE INDEX "consent_snapshots_session_captured_idx" ON "consent_snapshots" USING btree ("session_id","captured_at");--> statement-breakpoint
CREATE UNIQUE INDEX "delivery_outbox_event_destination_uidx" ON "delivery_outbox" USING btree ("event_id","destination");--> statement-breakpoint
CREATE INDEX "delivery_outbox_status_next_attempt_idx" ON "delivery_outbox" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE UNIQUE INDEX "leads_email_lookup_hash_uidx" ON "leads" USING btree ("email_lookup_hash");--> statement-breakpoint
CREATE INDEX "leads_verified_at_idx" ON "leads" USING btree ("verified_at");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_signals_setup_intent_uidx" ON "payment_signals" USING btree ("setup_intent_id");--> statement-breakpoint
CREATE INDEX "rate_windows_expires_idx" ON "rate_windows" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "report_sessions_token_hash_uidx" ON "report_sessions" USING btree ("session_token_hash");--> statement-breakpoint
CREATE INDEX "scan_checks_scan_status_idx" ON "scan_checks" USING btree ("scan_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "scan_shares_slug_hash_uidx" ON "scan_shares" USING btree ("share_slug_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "scan_shares_one_active_uidx" ON "scan_shares" USING btree ("scan_id") WHERE "scan_shares"."status" = 'published';--> statement-breakpoint
CREATE UNIQUE INDEX "scan_snapshots_cache_key_uidx" ON "scan_snapshots" USING btree ("cache_key");--> statement-breakpoint
CREATE UNIQUE INDEX "scans_session_idempotency_uidx" ON "scans" USING btree ("session_id","idempotency_key_hash");--> statement-breakpoint
CREATE INDEX "scans_target_accepted_idx" ON "scans" USING btree ("target_hash","accepted_at");--> statement-breakpoint
CREATE INDEX "scans_status_accepted_idx" ON "scans" USING btree ("status","accepted_at");--> statement-breakpoint
CREATE INDEX "scans_segment_finished_idx" ON "scans" USING btree ("segment","finished_at");--> statement-breakpoint
CREATE UNIQUE INDEX "sessions_anonymous_id_hash_uidx" ON "sessions" USING btree ("anonymous_id_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "verification_tokens_token_hash_uidx" ON "verification_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "verification_tokens_active_pair_uidx" ON "verification_tokens" USING btree ("lead_id","scan_id") WHERE "verification_tokens"."used_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "waitlist_entries_lead_scan_uidx" ON "waitlist_entries" USING btree ("lead_id","scan_id");--> statement-breakpoint
CREATE UNIQUE INDEX "waitlist_entries_position_uidx" ON "waitlist_entries" USING btree ("position");
--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_consent_snapshot_id_consent_snapshots_id_fk" FOREIGN KEY ("consent_snapshot_id") REFERENCES "public"."consent_snapshots"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "analytics_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "consent_snapshots" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "delivery_outbox" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "lead_scans" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "leads" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "payment_signals" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "rate_windows" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "report_sessions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "scan_checks" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "scan_fingerprints" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "scan_shares" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "scan_snapshots" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "scans" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "sessions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "verification_tokens" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "waitlist_entries" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "webhook_receipts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "worker_heartbeats" ENABLE ROW LEVEL SECURITY;
