-- What the order a merchant's shop made for a sale totals, as the shop recorded
-- it: what was paid or a cent either side of it. Rows placed before it was
-- kept have none.
ALTER TABLE "dashboard_woo_orders" ADD COLUMN "woo_order_total" text;
