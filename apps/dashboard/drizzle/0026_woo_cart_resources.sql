CREATE TABLE "dashboard_woo_cart_resources" (
  "shop_origin" text PRIMARY KEY NOT NULL,
  "owner" text NOT NULL,
  "next_creation_at" timestamp with time zone NOT NULL,
  "slots" jsonb NOT NULL
);
