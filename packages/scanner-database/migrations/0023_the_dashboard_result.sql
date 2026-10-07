-- What the dashboard answered when a scanner identity was deleted is kept under
-- the dashboard's name. The column was made when the dashboard was called the
-- cabinet; this renames it and nothing else, and the checks that read it follow
-- the column.
ALTER TABLE "scanner_identity_deletion_operations" RENAME COLUMN "cabinet_result" TO "dashboard_result";
