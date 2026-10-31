CREATE TABLE "merchant_live_request_backfill" (
	"id" text PRIMARY KEY NOT NULL,
	"completed_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "merchant_live_requests" (
	"merchant_id" text PRIMARY KEY NOT NULL,
	"id" text NOT NULL,
	"account_id" text,
	"requested_at" timestamp with time zone NOT NULL,
	"evidence" jsonb,
	"state" text NOT NULL,
	"decline_sequence" bigint,
	"reminder_due_at" timestamp with time zone NOT NULL,
	"reminder_created_at" timestamp with time zone,
	CONSTRAINT "merchant_live_requests_id_unique" UNIQUE("id"),
	CONSTRAINT "merchant_live_requests_state" CHECK ("merchant_live_requests"."state" in ('pending', 'declined', 'admitted')),
	CONSTRAINT "merchant_live_requests_decline" CHECK (("merchant_live_requests"."state" = 'declined') = ("merchant_live_requests"."decline_sequence" is not null))
);
--> statement-breakpoint
ALTER TABLE "operator_journal" DROP CONSTRAINT "operator_journal_action";--> statement-breakpoint
ALTER TABLE "merchant_live_requests" ADD CONSTRAINT "merchant_live_requests_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "merchant_live_requests_waiting" ON "merchant_live_requests" USING btree ("requested_at","merchant_id") WHERE "merchant_live_requests"."state" = 'pending';--> statement-breakpoint
ALTER TABLE "operator_journal" ADD CONSTRAINT "operator_journal_action" CHECK ("action" in ('admit', 'decline', 'withdraw', 'disable_key', 'end_sessions', 'grant_operator', 'remove_operator', 'forget_account', 'first_operator'));