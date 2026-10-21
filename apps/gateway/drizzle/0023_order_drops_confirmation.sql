-- The order document no longer has a confirmation step: no mode asks the
-- merchant before the money moves, so the flag for it, the two instants of it
-- and the two deadlines of it leave every stored order. No stored order ever
-- had the flag set or either instant written.
UPDATE "orders"
SET "record" = "record"
  #- '{order,mode,needsConfirmation}'
  #- '{order,timestamps,confirmationRequestedAt}'
  #- '{order,timestamps,confirmedAt}'
  #- '{order,policy,deadlines,confirmationResponseMs}'
  #- '{order,policy,deadlines,paymentAfterConfirmationMs}'
WHERE "record" -> 'order' -> 'mode' ? 'needsConfirmation'
   OR "record" -> 'order' -> 'timestamps' ? 'confirmationRequestedAt'
   OR "record" -> 'order' -> 'timestamps' ? 'confirmedAt'
   OR "record" -> 'order' -> 'policy' -> 'deadlines' ? 'confirmationResponseMs'
   OR "record" -> 'order' -> 'policy' -> 'deadlines' ? 'paymentAfterConfirmationMs';
