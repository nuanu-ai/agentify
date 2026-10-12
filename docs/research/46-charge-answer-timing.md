# How long the payment layer takes to answer a charge

Date: 2026-10-12. A research note that may be rewritten. It holds the
measurements behind the gateway's two waits for a charge, `SETTLE_RESPONSE_MS`
and `SETTLE_BEFORE_GOODS_MS`, and what those waits still leave exposed.

## What the waits are

When the gateway sends a charge to the payment layer (the x402 facilitator), it
arms a deadline on the order. If no answer has come when the deadline passes,
the order machine declares the charge silent: the order's payment reads
`outcome_unknown`, which nobody can tell apart from a charge that never went
through. The facilitator answers only once the transfer is in a block, and Base
and Base Sepolia each make a block every two seconds, so a deadline close to
two seconds sits right where the answers arrive.

On an order paid before its goods (asynchronous, confirmed or a parcel), a
charge declared silent closes the order without dispatching it. If the charge
then lands after all, the order becomes `refund_due`: the merchant holds money
for goods they were never asked to make, and owes it back. These orders now wait
fifteen seconds (`SETTLE_BEFORE_GOODS_MS`). A synchronous order, where the
merchant has already made the goods, still waits two (`SETTLE_RESPONSE_MS`),
because that wait sits inside the ten seconds the portal promises its agent.

The deadline does not decide how long the agent's purchase call takes. On an
order paid before its goods, the call waits for the facilitator's answer
itself, and the deadline is a reminder running beside it. The call is bounded
by the HTTP client of `@x402/core` (version 2.23.0), whose default timeout of
thirty seconds the gateway does not change. What the longer deadline changes,
when the facilitator answers between two and fifteen seconds, is the answer the
call returns, `in_progress` where it used to be `refund_due`, and what the
order's `status_url` reads until the facilitator answers, `in_progress` where it
used to be `payment_unresolved`.

## What was measured

The figures come from read-only queries against the orders on TEST and on
production. Each transfer's time was taken from its block number, which is
exact because a block comes every two seconds, and compared with the moment the
gateway sent the charge.

On TEST, 31 transfers landed between 0.9 and 2.9 seconds after the charge was
sent, with a median of 1.9 seconds; 14 of them took two seconds or more. Of the
21 charges made before the goods, 2 were declared silent and became refunds
owed that nobody owed. None of the 13 synchronous charges was declared silent.
On production, the one live charge landed 2.7 seconds after it was sent. A read
of production's orders on 2026-10-12 found no order in `refund_due` or
`delivered_unpaid`, and none whose payment reads `outcome_unknown`.

Whether the two refunds on TEST were ever reconciled has not been checked. The
change to the wait does not touch orders that already exist.

## What stays open

The synchronous order keeps the same exposure. Its charge travels on the same
chain through the same facilitator, and 0 of 13 against 2 of 21 is not a
difference: at the rate seen on the other orders about 1.2 of the 13 would be
expected to go silent, and seeing none happens roughly a quarter of the time.
A silent synchronous charge answers the waiting agent with no goods and
`payment_unresolved`, the merchant is sent `order.payment_failed_after_delivery`
once, and if the charge then lands, the order becomes delivered after the
agent's call has already returned. Raising this wait means dividing the
ten-second ceiling differently while the portal promises the merchant eight
seconds to answer (`apps/docs/failures.md`, `apps/docs/orders.md`,
`apps/docs/quickstart.md`). That is the product owner's decision, and it is
kept in `00-open-questions.md`.

The samples are small: thirty-one transfers on a test chain and one on
production. They show where the answers fall, not how often a busy chain would
push one past fifteen seconds.
