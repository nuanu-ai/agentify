-- When each card was first published, which a republish leaves alone, unlike
-- `as_of`. A card already here takes its `as_of`: for one never republished
-- that is its first publication, and for one republished it is the last, the
-- nearest moment the table still holds.
ALTER TABLE "cards" ADD COLUMN "published_at" timestamp with time zone;--> statement-breakpoint
UPDATE "cards" SET "published_at" = "as_of";--> statement-breakpoint
ALTER TABLE "cards" ALTER COLUMN "published_at" SET NOT NULL;
