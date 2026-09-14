CREATE TYPE "public"."browser_observation_status" AS ENUM('queued', 'starting', 'running', 'completed', 'partial', 'blocked', 'failed', 'budget_skipped');--> statement-breakpoint
CREATE TABLE "browser_observation_findings" (
	"observation_id" uuid NOT NULL,
	"finding_id" text NOT NULL,
	"status" "check_status" NOT NULL,
	"summary_code" text NOT NULL,
	"user_impact_code" text,
	"remediation_code" text,
	"evidence" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"duration_ms" integer,
	CONSTRAINT "browser_observation_findings_observation_id_finding_id_pk" PRIMARY KEY("observation_id","finding_id"),
	CONSTRAINT "browser_observation_findings_terminal_status" CHECK ("browser_observation_findings"."status" not in ('pending', 'running'))
);
--> statement-breakpoint
CREATE TABLE "browser_observations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"scan_id" uuid NOT NULL,
	"observation_version" text NOT NULL,
	"operation_id" uuid NOT NULL,
	"operation_key" text NOT NULL,
	"status" "browser_observation_status" DEFAULT 'queued' NOT NULL,
	"actor_id" text NOT NULL,
	"actor_build" text NOT NULL,
	"apify_run_id" text,
	"attempt_no" smallint DEFAULT 1 NOT NULL,
	"lease_expires_at" timestamp with time zone,
	"queued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"last_polled_at" timestamp with time zone,
	"pages_assessed" smallint DEFAULT 0 NOT NULL,
	"request_count" integer DEFAULT 0 NOT NULL,
	"transferred_bytes" integer DEFAULT 0 NOT NULL,
	"duration_ms" integer,
	"usage_usd" numeric(10, 6),
	"failure_code" text,
	"signals" jsonb,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "browser_observations_id_uuidv7" CHECK (substring("browser_observations"."id"::text, 15, 1) = '7'),
	CONSTRAINT "browser_observations_operation_id_uuidv7" CHECK (substring("browser_observations"."operation_id"::text, 15, 1) = '7'),
	CONSTRAINT "browser_observations_attempt_once" CHECK ("browser_observations"."attempt_no" = 1),
	CONSTRAINT "browser_observations_pages_range" CHECK ("browser_observations"."pages_assessed" between 0 and 3),
	CONSTRAINT "browser_observations_usage_nonnegative" CHECK ("browser_observations"."usage_usd" is null or "browser_observations"."usage_usd" >= 0)
);
--> statement-breakpoint
ALTER TABLE "browser_observation_findings" ADD CONSTRAINT "browser_observation_findings_observation_id_browser_observations_id_fk" FOREIGN KEY ("observation_id") REFERENCES "public"."browser_observations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "browser_observations" ADD CONSTRAINT "browser_observations_scan_id_scans_id_fk" FOREIGN KEY ("scan_id") REFERENCES "public"."scans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "browser_observation_findings_status_idx" ON "browser_observation_findings" USING btree ("observation_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "browser_observations_operation_key_uidx" ON "browser_observations" USING btree ("operation_key");--> statement-breakpoint
CREATE UNIQUE INDEX "browser_observations_operation_id_uidx" ON "browser_observations" USING btree ("operation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "browser_observations_scan_version_uidx" ON "browser_observations" USING btree ("scan_id","observation_version");--> statement-breakpoint
CREATE INDEX "browser_observations_status_queued_idx" ON "browser_observations" USING btree ("status","queued_at");--> statement-breakpoint
CREATE INDEX "browser_observations_run_idx" ON "browser_observations" USING btree ("apify_run_id");
--> statement-breakpoint
ALTER TABLE "browser_observations" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "browser_observations" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "browser_observation_findings" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "browser_observation_findings" FORCE ROW LEVEL SECURITY;
