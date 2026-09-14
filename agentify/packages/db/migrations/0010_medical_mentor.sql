CREATE TABLE "rate_limit_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"key_hash" text NOT NULL,
	"kind" text NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"challenge_passed" boolean DEFAULT false NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "rate_limit_events_id_uuidv7" CHECK (substring("rate_limit_events"."id"::text, 15, 1) = '7')
);
--> statement-breakpoint
CREATE INDEX "rate_limit_events_lookup_idx" ON "rate_limit_events" USING btree ("key_hash","kind","occurred_at");--> statement-breakpoint
CREATE INDEX "rate_limit_events_expires_idx" ON "rate_limit_events" USING btree ("expires_at");--> statement-breakpoint
ALTER TABLE "rate_limit_events" ENABLE ROW LEVEL SECURITY;
