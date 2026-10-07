-- The key the dashboard calls the gateway with is called the dashboard's.
--
-- Migration 0007 marked it with the purpose `cabinet`, the dashboard's old
-- name. From this migration on the code reads and writes `dashboard`, so the
-- rows already written are renamed with it: left as they were, the dashboard's
-- key would no longer be recognised as one, the dashboard could not issue or
-- forget it, and a merchant's list would start showing a key they never made.
-- A merchant's own keys are `merchant_code` and are not touched.
UPDATE "merchant_keys" SET "purpose" = 'dashboard' WHERE "purpose" = 'cabinet';
