-- One table for everything the dashboard tells the ad tracker: a registration,
-- and the first card of the merchant that registration came to, which waits
-- after the registration for that card. A row is one account's report of one
-- event.
--
-- Every registration report already written moves across as it stands, as a
-- `reg` row whose fact happened when it was written, its click kept only while
-- it is still pending; then the old table goes.
CREATE TABLE "dashboard_ad_reports" (
	"account_id" text NOT NULL,
	"event" text NOT NULL,
	"click_id" text,
	"state" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"last_outcome" text,
	"created_at" timestamp with time zone NOT NULL,
	"event_at" timestamp with time zone,
	"settled_at" timestamp with time zone,
	CONSTRAINT "dashboard_ad_reports_account_id_event_pk" PRIMARY KEY("account_id","event"),
	CONSTRAINT "dashboard_ad_reports_event" CHECK ("dashboard_ad_reports"."event" in ('reg', 'store_connected')),
	CONSTRAINT "dashboard_ad_reports_state" CHECK ("dashboard_ad_reports"."state" in ('waiting', 'pending', 'delivered', 'refused', 'given_up', 'lapsed')),
	CONSTRAINT "dashboard_ad_reports_only_a_store_report_waits" CHECK ("dashboard_ad_reports"."event" = 'store_connected' or "dashboard_ad_reports"."state" not in ('waiting', 'lapsed')),
	CONSTRAINT "dashboard_ad_reports_open_holds_click" CHECK (("dashboard_ad_reports"."state" in ('waiting', 'pending')) = ("dashboard_ad_reports"."click_id" is not null)),
	CONSTRAINT "dashboard_ad_reports_pending_scheduled" CHECK ("dashboard_ad_reports"."state" <> 'pending' or "dashboard_ad_reports"."next_attempt_at" is not null),
	CONSTRAINT "dashboard_ad_reports_settled_dated" CHECK (("dashboard_ad_reports"."state" in ('waiting', 'pending')) = ("dashboard_ad_reports"."settled_at" is null)),
	CONSTRAINT "dashboard_ad_reports_fact_dated" CHECK (("dashboard_ad_reports"."state" in ('waiting', 'lapsed')) = ("dashboard_ad_reports"."event_at" is null))
);
--> statement-breakpoint
INSERT INTO "dashboard_ad_reports"
	("account_id", "event", "click_id", "state", "attempts", "next_attempt_at", "last_outcome", "created_at", "event_at", "settled_at")
SELECT "account_id", 'reg', "click_id", "state", "attempts", "next_attempt_at", "last_outcome", "created_at", "created_at", "settled_at"
FROM "dashboard_registration_postbacks";--> statement-breakpoint
DROP TABLE "dashboard_registration_postbacks" CASCADE;--> statement-breakpoint
ALTER TABLE "dashboard_ad_reports" ADD CONSTRAINT "dashboard_ad_reports_account_id_dashboard_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."dashboard_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "dashboard_ad_reports_due_idx" ON "dashboard_ad_reports" USING btree ("next_attempt_at") WHERE "dashboard_ad_reports"."state" = 'pending';--> statement-breakpoint
CREATE INDEX "dashboard_ad_reports_waiting_idx" ON "dashboard_ad_reports" USING btree ("created_at") WHERE "dashboard_ad_reports"."state" = 'waiting';