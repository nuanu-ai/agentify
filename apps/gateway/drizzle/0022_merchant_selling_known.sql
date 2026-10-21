-- A merchant's selling word is open or paused. The column refuses any other,
-- so the store reads it without a check of its own.
ALTER TABLE "merchants" ADD CONSTRAINT "merchants_selling_known" CHECK ("merchants"."selling" in ('open', 'paused'));
