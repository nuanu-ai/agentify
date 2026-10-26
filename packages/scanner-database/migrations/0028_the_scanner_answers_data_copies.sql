-- A request for a copy of an address's data becomes a row of its own, which
-- keeps the address only until the copy is mailed or every try fails. Each request a lead recorded
-- before copies were answered becomes one waiting to be answered at once,
-- dated when it was first asked, unless its address was deleted; then the
-- lead's column goes.
CREATE TABLE "data_copy_requests" (
	"id" uuid PRIMARY KEY NOT NULL,
	"email_lookup_hash" text NOT NULL,
	"email_normalized_ciphertext" text,
	"state" text DEFAULT 'pending' NOT NULL,
	"attempts" smallint DEFAULT 0 NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"lease_token" uuid,
	"lease_expires_at" timestamp with time zone,
	"last_outcome" text,
	"settled_at" timestamp with time zone,
	CONSTRAINT "data_copy_requests_state" CHECK ("data_copy_requests"."state" in ('pending', 'sent', 'failed')),
	CONSTRAINT "data_copy_requests_pending_scheduled" CHECK (("data_copy_requests"."state" = 'pending') = ("data_copy_requests"."next_attempt_at" is not null)),
	CONSTRAINT "data_copy_requests_settled_dated" CHECK (("data_copy_requests"."state" = 'pending') = ("data_copy_requests"."settled_at" is null)),
	CONSTRAINT "data_copy_requests_address_while_pending" CHECK (("data_copy_requests"."state" = 'pending') = ("data_copy_requests"."email_normalized_ciphertext" is not null)),
	CONSTRAINT "data_copy_requests_last_outcome" CHECK ("data_copy_requests"."last_outcome" is null or "data_copy_requests"."last_outcome" in ('refused', 'no_answer'))
);
--> statement-breakpoint
ALTER TABLE "data_copy_requests" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE UNIQUE INDEX "data_copy_requests_one_pending_uidx" ON "data_copy_requests" USING btree ("email_lookup_hash") WHERE "data_copy_requests"."state" = 'pending';--> statement-breakpoint
CREATE INDEX "data_copy_requests_address_idx" ON "data_copy_requests" USING btree ("email_lookup_hash","requested_at");--> statement-breakpoint
CREATE INDEX "data_copy_requests_due_idx" ON "data_copy_requests" USING btree ("next_attempt_at") WHERE "data_copy_requests"."state" = 'pending';--> statement-breakpoint
INSERT INTO "data_copy_requests" ("id", "email_lookup_hash", "email_normalized_ciphertext", "state", "attempts", "requested_at", "next_attempt_at")
SELECT gen_random_uuid(), "email_lookup_hash", "email_normalized_ciphertext", 'pending', 0, "data_access_requested_at", now()
FROM "leads"
WHERE "data_access_requested_at" IS NOT NULL AND "anonymized_at" IS NULL AND "deletion_requested_at" IS NULL;--> statement-breakpoint
ALTER TABLE "leads" DROP COLUMN "data_access_requested_at";