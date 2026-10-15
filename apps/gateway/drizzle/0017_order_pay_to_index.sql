-- Whether any order of a merchant's was paid to a given payout split.
--
-- A merchant's payout, and the operator's, cover every split an order was
-- verified against, and ask it of each split they might cover. The address
-- lives inside the order's document, so without this index each question
-- reads and unpacks every document of that merchant's. It is built in the
-- migration's transaction and holds writes to orders while it is built, which
-- on today's tables is a moment; it changes no row.
CREATE INDEX "orders_pay_to_idx" ON "orders" USING btree ("merchant_id",lower("record" ->> 'payTo'));
