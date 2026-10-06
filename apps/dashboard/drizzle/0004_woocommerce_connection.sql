CREATE TABLE "cabinet_woo_grants" (
	"token" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"shop_url" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cabinet_woo_orders" (
	"order_id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"woo_order_id" text,
	"woo_order_number" text,
	"attempted_at" timestamp with time zone NOT NULL,
	"placed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "cabinet_woo_shops" (
	"account_id" text PRIMARY KEY NOT NULL,
	"shop_url" text NOT NULL,
	"consumer_key" text NOT NULL,
	"consumer_secret" text NOT NULL,
	"permissions" text NOT NULL,
	"connected_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "cabinet_woo_grants" ADD CONSTRAINT "cabinet_woo_grants_account_id_cabinet_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."cabinet_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cabinet_woo_orders" ADD CONSTRAINT "cabinet_woo_orders_account_id_cabinet_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."cabinet_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cabinet_woo_shops" ADD CONSTRAINT "cabinet_woo_shops_account_id_cabinet_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."cabinet_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "cabinet_woo_grants_expires_idx" ON "cabinet_woo_grants" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "cabinet_woo_orders_account_idx" ON "cabinet_woo_orders" USING btree ("account_id");