-- The nightly cleanup finds raw analytics events past their retention by when
-- they occurred, without reading the whole table.
CREATE INDEX "analytics_events_occurred_idx" ON "analytics_events" USING btree ("occurred_at");