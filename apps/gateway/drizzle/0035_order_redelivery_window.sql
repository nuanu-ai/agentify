-- An order nobody answers is handed over again for a window after its first
-- hand-over instead of a count of attempts, so every open order takes the
-- published window and its fifteen-minute ceiling on pauses in place of its
-- five attempts. Its first hand-over was never recorded; the latest one is the
-- nearest known, which gives an order already being repeated the most room.
-- A closed order is never handed over again and keeps the terms it ended under.
UPDATE "orders"
SET "record" = jsonb_set(
  jsonb_set(
    jsonb_set(
      "record" #- '{order,policy,redelivery,maxAttempts}',
      '{order,policy,redelivery,windowMs}',
      '10800000'
    ),
    '{order,policy,redelivery,maxDelayMs}',
    '900000'
  ),
  '{order,timestamps,firstDispatchedAt}',
  COALESCE("record" -> 'order' -> 'timestamps' -> 'dispatchedAt', 'null'::jsonb)
)
WHERE "open" AND "record" -> 'order' -> 'policy' -> 'redelivery' ? 'maxAttempts';
