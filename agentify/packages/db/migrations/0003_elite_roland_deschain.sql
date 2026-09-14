ALTER TABLE "analytics_events" ADD COLUMN "once_key" text;--> statement-breakpoint
CREATE UNIQUE INDEX "analytics_events_once_key_uidx" ON "analytics_events" USING btree ("once_key");