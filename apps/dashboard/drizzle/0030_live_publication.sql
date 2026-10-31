CREATE TABLE "dashboard_live_publications" (
	"id" text PRIMARY KEY NOT NULL,
	"merchant_id" text NOT NULL,
	"account_id" text NOT NULL,
	"event" jsonb NOT NULL,
	"job_id" text,
	"state" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "dashboard_live_publications_state" CHECK ("dashboard_live_publications"."state" in ('pending', 'completed'))
);
--> statement-breakpoint
ALTER TABLE "dashboard_live_sales_mail" DROP CONSTRAINT "dashboard_live_sales_mail_kind";--> statement-breakpoint
ALTER TABLE "dashboard_live_publications" ADD CONSTRAINT "dashboard_live_publications_account_id_dashboard_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."dashboard_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "dashboard_live_publications_pending" ON "dashboard_live_publications" USING btree ("created_at") WHERE "dashboard_live_publications"."state" = 'pending';--> statement-breakpoint
ALTER TABLE "dashboard_live_sales_mail" ADD CONSTRAINT "dashboard_live_sales_mail_kind" CHECK ("dashboard_live_sales_mail"."kind" in ('requested', 'declined', 'reminder', 'admitted', 'published', 'withdrawn'));