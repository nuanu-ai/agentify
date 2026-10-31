CREATE TABLE "dashboard_live_sales_mail" (
	"id" text PRIMARY KEY NOT NULL,
	"request_id" text NOT NULL,
	"merchant_id" text NOT NULL,
	"recipient_account_id" text NOT NULL,
	"requester_account_id" text,
	"kind" text NOT NULL,
	"event" jsonb NOT NULL,
	"message" jsonb,
	"state" text DEFAULT 'pending' NOT NULL,
	"suppression" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_outcome" text,
	"created_at" timestamp with time zone NOT NULL,
	"next_attempt_at" timestamp with time zone NOT NULL,
	"prepared_at" timestamp with time zone,
	"prepared_from" text,
	"prepared_provider" text,
	"last_attempt_at" timestamp with time zone,
	"settled_at" timestamp with time zone,
	CONSTRAINT "dashboard_live_sales_mail_kind" CHECK ("dashboard_live_sales_mail"."kind" in ('requested', 'declined', 'reminder')),
	CONSTRAINT "dashboard_live_sales_mail_state" CHECK ("dashboard_live_sales_mail"."state" in ('pending', 'accepted', 'suppressed', 'given_up')),
	CONSTRAINT "dashboard_live_sales_mail_outcome" CHECK ("dashboard_live_sales_mail"."last_outcome" is null or "dashboard_live_sales_mail"."last_outcome" in ('accepted', 'refused', 'held', 'unknown')),
	CONSTRAINT "dashboard_live_sales_mail_attempts" CHECK ("dashboard_live_sales_mail"."attempts" >= 0)
);
--> statement-breakpoint
ALTER TABLE "dashboard_live_sales_mail" ADD CONSTRAINT "dashboard_live_sales_mail_recipient_account_id_dashboard_accounts_id_fk" FOREIGN KEY ("recipient_account_id") REFERENCES "public"."dashboard_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dashboard_live_sales_mail" ADD CONSTRAINT "dashboard_live_sales_mail_requester_account_id_dashboard_accounts_id_fk" FOREIGN KEY ("requester_account_id") REFERENCES "public"."dashboard_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "dashboard_live_sales_mail_recipient_event" ON "dashboard_live_sales_mail" USING btree ("request_id","kind","recipient_account_id");--> statement-breakpoint
CREATE INDEX "dashboard_live_sales_mail_due" ON "dashboard_live_sales_mail" USING btree ("next_attempt_at") WHERE "dashboard_live_sales_mail"."state" = 'pending';--> statement-breakpoint
CREATE INDEX "dashboard_live_sales_mail_requester" ON "dashboard_live_sales_mail" USING btree ("requester_account_id");--> statement-breakpoint
CREATE INDEX "dashboard_live_sales_mail_recipient" ON "dashboard_live_sales_mail" USING btree ("recipient_account_id");