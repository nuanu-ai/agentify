CREATE TABLE "dashboard_shop_job_products" (
	"job_id" text NOT NULL,
	"product_id" text NOT NULL,
	"data" jsonb NOT NULL,
	CONSTRAINT "dashboard_shop_job_products_job_id_product_id_pk" PRIMARY KEY("job_id","product_id")
);
--> statement-breakpoint
CREATE TABLE "dashboard_shop_jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"merchant_id" text NOT NULL,
	"kind" text NOT NULL,
	"status" text NOT NULL,
	"data" jsonb NOT NULL
);
--> statement-breakpoint
ALTER TABLE "dashboard_shop_job_products" ADD CONSTRAINT "dashboard_shop_job_products_job_id_dashboard_shop_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."dashboard_shop_jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dashboard_shop_jobs" ADD CONSTRAINT "dashboard_shop_jobs_account_id_dashboard_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."dashboard_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "dashboard_shop_jobs_active" ON "dashboard_shop_jobs" USING btree ("merchant_id") WHERE status in ('queued', 'running');
--> statement-breakpoint
CREATE TABLE "dashboard_woo_card_pauses" (
	"merchant_id" text NOT NULL,
	"item_id" text NOT NULL,
	"paused_at" timestamp with time zone NOT NULL,
	"reason" text NOT NULL,
	CONSTRAINT "dashboard_woo_card_pause_reason" CHECK ("reason" in ('stopped_selling', 'changed')),
	CONSTRAINT "dashboard_woo_card_pauses_merchant_id_item_id_pk" PRIMARY KEY("merchant_id","item_id")
);

--> statement-breakpoint
CREATE FUNCTION dashboard_release_woo_card_pause() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM dashboard_woo_card_pauses WHERE merchant_id=NEW.merchant_id AND item_id=NEW.id;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER dashboard_release_woo_card_pause AFTER UPDATE OF paused ON cards
FOR EACH ROW EXECUTE FUNCTION dashboard_release_woo_card_pause();
