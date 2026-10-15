-- The registration the dashboard reports to the ad tracker whose click brought
-- a person. A row is written in the transaction where a link asked for with a
-- consented click makes an address's first verified account, so an account has
-- at most one and only somebody who ticked the box has any. The click id is
-- kept while the report is pending and erased once the row is final; the
-- consent time and the version of the sentence agreed to stay as the evidence,
-- since the link's claim that carried them is deleted when the link is spent.
-- The row goes with its account.
--
-- The table starts empty: nobody already here was asked, so nothing is owed
-- for them.
CREATE TABLE "dashboard_registration_postbacks" (
	"account_id" text PRIMARY KEY NOT NULL,
	"click_id" text,
	"consented_at" timestamp with time zone NOT NULL,
	"consent_wording" text NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"last_outcome" text,
	"created_at" timestamp with time zone NOT NULL,
	"settled_at" timestamp with time zone,
	CONSTRAINT "dashboard_registration_postbacks_state" CHECK ("dashboard_registration_postbacks"."state" in ('pending', 'delivered', 'refused', 'given_up')),
	CONSTRAINT "dashboard_registration_postbacks_pending_holds_click" CHECK (("dashboard_registration_postbacks"."state" = 'pending') = ("dashboard_registration_postbacks"."click_id" is not null)),
	CONSTRAINT "dashboard_registration_postbacks_pending_scheduled" CHECK ("dashboard_registration_postbacks"."state" <> 'pending' or "dashboard_registration_postbacks"."next_attempt_at" is not null),
	CONSTRAINT "dashboard_registration_postbacks_settled_dated" CHECK ("dashboard_registration_postbacks"."state" = 'pending' or "dashboard_registration_postbacks"."settled_at" is not null)
);
--> statement-breakpoint
ALTER TABLE "dashboard_registration_postbacks" ADD CONSTRAINT "dashboard_registration_postbacks_account_id_dashboard_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."dashboard_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "dashboard_registration_postbacks_due_idx" ON "dashboard_registration_postbacks" USING btree ("next_attempt_at") WHERE "dashboard_registration_postbacks"."state" = 'pending';