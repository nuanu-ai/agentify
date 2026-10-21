-- Drops the table of the retired merchant application form. Nothing has
-- written to it since the form closed, and every row it held has passed its
-- 30-day retention, so applying this deletes no application that was still
-- owed to its sender.
DROP TABLE "merchant_applications" CASCADE;