CREATE TABLE "browser_observation_budget_days" (
	"budget_day" date PRIMARY KEY NOT NULL,
	"reserved_usd" numeric(12, 6) DEFAULT '0' NOT NULL,
	"usage_usd" numeric(12, 6) DEFAULT '0' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "browser_observation_budget_days_reserved_nonnegative" CHECK ("browser_observation_budget_days"."reserved_usd" >= 0),
	CONSTRAINT "browser_observation_budget_days_usage_nonnegative" CHECK ("browser_observation_budget_days"."usage_usd" >= 0)
);
--> statement-breakpoint
ALTER TABLE "browser_observations" ADD COLUMN "lease_token" uuid;--> statement-breakpoint
ALTER TABLE "browser_observations" ADD COLUMN "budget_day" date;--> statement-breakpoint
ALTER TABLE "browser_observations" ADD COLUMN "budget_reserved_usd" numeric(10, 6) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "browser_observations" ADD COLUMN "storage_cleaned_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "browser_observations" ADD CONSTRAINT "browser_observations_budget_reservation_nonnegative" CHECK ("browser_observations"."budget_reserved_usd" >= 0);
--> statement-breakpoint
ALTER TABLE "browser_observation_budget_days" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "browser_observation_budget_days" FORCE ROW LEVEL SECURITY;
