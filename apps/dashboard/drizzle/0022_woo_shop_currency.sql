CREATE TABLE "dashboard_woo_rates" (
	"version" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "dashboard_woo_rates_version_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"account_id" text NOT NULL,
	"shop_origin" text NOT NULL,
	"currency" text NOT NULL,
	"rate" text NOT NULL,
	"set_at" timestamp with time zone NOT NULL,
	"set_by" text NOT NULL,
	"reference_rate" text,
	"reference_source" text,
	"reference_read_at" timestamp with time zone,
	"confirmed" boolean NOT NULL
);
--> statement-breakpoint
ALTER TABLE "dashboard_woo_grants" ADD COLUMN "currency" text;--> statement-breakpoint
ALTER TABLE "dashboard_woo_grants" ADD COLUMN "currency_decimals" integer;--> statement-breakpoint
ALTER TABLE "dashboard_woo_quotes" ADD COLUMN "shop_amount" text;--> statement-breakpoint
ALTER TABLE "dashboard_woo_quotes" ADD COLUMN "shop_currency" text;--> statement-breakpoint
ALTER TABLE "dashboard_woo_quotes" ADD COLUMN "dollars" text;--> statement-breakpoint
ALTER TABLE "dashboard_woo_quotes" ADD COLUMN "rate_version" integer;--> statement-breakpoint
ALTER TABLE "dashboard_woo_shops" ADD COLUMN "currency" text;--> statement-breakpoint
ALTER TABLE "dashboard_woo_shops" ADD COLUMN "currency_decimals" integer;--> statement-breakpoint
ALTER TABLE "dashboard_woo_rates" ADD CONSTRAINT "dashboard_woo_rates_account_id_dashboard_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."dashboard_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "dashboard_woo_rates_current_idx" ON "dashboard_woo_rates" USING btree ("account_id","shop_origin","currency","version");