-- Product analytics events waiting to leave for Nuanu Analytics. Nothing here
-- constrains what an event says, because a refused insert would fail the
-- transaction of the fact it records; the sender checks that and refuses to
-- send what breaks the contract.
CREATE TABLE "commerce_analytics_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"sequence" bigint GENERATED ALWAYS AS IDENTITY (sequence name "commerce_analytics_events_sequence_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"name" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"actor_type" text NOT NULL,
	"source" text NOT NULL,
	"properties" jsonb NOT NULL,
	"refs" jsonb NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"last_outcome" text,
	"sent_at" timestamp with time zone,
	"settled_at" timestamp with time zone,
	CONSTRAINT "commerce_analytics_events_sequence_unique" UNIQUE("sequence"),
	CONSTRAINT "commerce_analytics_events_state" CHECK ("commerce_analytics_events"."state" in ('pending', 'sent', 'dead', 'given_up', 'suppressed')),
	CONSTRAINT "commerce_analytics_events_attempts" CHECK ("commerce_analytics_events"."attempts" >= 0),
	CONSTRAINT "commerce_analytics_events_pending_scheduled" CHECK (("commerce_analytics_events"."state" = 'pending') = ("commerce_analytics_events"."next_attempt_at" is not null)),
	CONSTRAINT "commerce_analytics_events_settled_dated" CHECK (("commerce_analytics_events"."state" = 'pending') = ("commerce_analytics_events"."settled_at" is null)),
	CONSTRAINT "commerce_analytics_events_sent_dated" CHECK (("commerce_analytics_events"."state" = 'sent') = ("commerce_analytics_events"."sent_at" is not null))
);
--> statement-breakpoint
CREATE INDEX "commerce_analytics_events_due_idx" ON "commerce_analytics_events" USING btree ("next_attempt_at") WHERE "commerce_analytics_events"."state" = 'pending';--> statement-breakpoint
CREATE INDEX "commerce_analytics_events_pending_age_idx" ON "commerce_analytics_events" USING btree ("occurred_at") WHERE "commerce_analytics_events"."state" = 'pending';--> statement-breakpoint
CREATE INDEX "commerce_analytics_events_settled_idx" ON "commerce_analytics_events" USING btree ("settled_at") WHERE "commerce_analytics_events"."state" <> 'pending';