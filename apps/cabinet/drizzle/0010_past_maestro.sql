CREATE TABLE "cabinet_woo_quotes" (
	"price_id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"merchant_item_id" text NOT NULL,
	"product_fingerprint" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "cabinet_woo_quotes" ADD CONSTRAINT "cabinet_woo_quotes_account_id_cabinet_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."cabinet_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "cabinet_woo_quotes_account_idx" ON "cabinet_woo_quotes" USING btree ("account_id");