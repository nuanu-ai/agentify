UPDATE "orders"
SET "state" = CASE "state" WHEN 'refund_due' THEN 'unfulfilled' ELSE 'fulfillment_closed' END,
    "record" = jsonb_set("record", '{order,state}', to_jsonb(CASE "record" -> 'order' ->> 'state' WHEN 'refund_due' THEN 'unfulfilled' ELSE 'fulfillment_closed' END::text))
WHERE "state" IN ('refund_due', 'refunded');
--> statement-breakpoint
UPDATE "receipts"
SET "receipt" = jsonb_set("receipt", '{outcome}', to_jsonb(CASE "receipt" ->> 'outcome' WHEN 'refund_due' THEN 'unfulfilled' ELSE 'fulfillment_closed' END::text))
WHERE "receipt" ->> 'outcome' IN ('refund_due', 'refunded');
--> statement-breakpoint
DO $$
BEGIN
  IF to_regclass('pgboss.job') IS NOT NULL THEN
    UPDATE pgboss.job
    SET data = jsonb_set(data, '{payload,type}', '"order.unfulfilled"'::jsonb)
    WHERE data ->> 'kind' = 'order_event'
      AND data -> 'payload' ->> 'type' = 'order.refund_due';
  END IF;
END $$;
