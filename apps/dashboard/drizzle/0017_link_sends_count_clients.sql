ALTER TABLE "dashboard_link_sends" ADD COLUMN "client_hash" text;--> statement-breakpoint
CREATE INDEX "dashboard_link_sends_client_idx" ON "dashboard_link_sends" USING btree ("client_hash","purpose","sent_at");--> statement-breakpoint
CREATE INDEX "dashboard_link_sends_channel_idx" ON "dashboard_link_sends" USING btree ("purpose","sent_at");