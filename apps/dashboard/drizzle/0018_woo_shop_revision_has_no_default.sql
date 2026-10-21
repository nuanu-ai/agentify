-- Every connection writes its own revision, and none stored still carries the
-- old placeholder, so the column takes no default: a write that forgets the
-- revision is refused rather than given one that matches nothing.
ALTER TABLE "dashboard_woo_shops" ALTER COLUMN "revision" DROP DEFAULT;
