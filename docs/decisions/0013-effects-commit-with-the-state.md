# 0013. An effect commits with the state that implies it

Date: 2026-08-27
Status: accepted

## Context

With each new state the order machine returns the effects it implies: the
hand-over of the order to its merchant, the merchant events, the receipt, the
deadline that fires if nobody answers. If the state commits and the process
dies before the effects run, a retry cannot repair it: an order that says
`paid` and was never handed over has moved past the transition that emits the
hand-over. A `delivered` order with no receipt is a sale its merchant cannot
reconcile, and an open order whose reminder was lost is one nothing will
close or refund.

## Decision

An effect that cannot be re-driven once the order has moved past it is written
in the same transaction as the order. Orders, receipts and the queue share one
Postgres (ADR-0003 §6), and pg-boss accepts a handle that runs one statement,
so the job is inserted inside the store's transaction and commits or rolls back
with the order. The store's port names three such writes: an envelope on a
merchant's stream (a hand-over, a redelivery, a merchant event); a receipt, our
own row keyed by its order; and the deletion of the envelopes that carry a
parcel's address (ADR-0032). A fourth is a decision, not a detail. The other
effects, such as a call to the facilitator, run after the commit and outside
the row lock: their result is the next event about the same order, which under
the lock would wait for a lock only it could release.

Deadlines stay outside. A reminder is armed before the order is written, so an
order with no clock on it cannot happen; a reminder left by a write that then
failed is refused by the machine when it fires, and removing that harmless
litter is not worth a longer hold on the row.

A daily sweep asks the orders what they are still owed, rather than keeping a
second record of intent: a `paid` order with nothing on its merchant's stream
is handed over again, a `delivered` order with no receipt gets one unless an
operator recorded its settlement (ADR-0027), and a passed deadline on an order
still in its state is armed again. An effect may be swept only when its
receiver is promised a repeat and the repeat costs the order nothing that
belongs to a real failure. A receipt and a reminder pass
both: writing a receipt again writes the same row, and the machine refuses an
expiry that no longer applies. A hand-over passes the first only, because every
hand-over counts against the order's redelivery cap and the closure at the cap
is a refund; so the sweep skips an order whose envelope is still on the stream
or whose payment is younger than a configured patience, and runs one at a time
under a lock, since two runs side by side both find the stream empty. A
merchant event is delivered at most once, so the sweep has no arm for it and
must not get one. The deletion has no receiver. Every path that hands an order
over, not only the sweep, owes the same question before it spends a redelivery.

## Consequences

A process that dies mid-flight has done both or neither, and what it missed is
found by asking the orders. Delivery is at least once, not exactly once, which
is what the contract promises a merchant. A Postgres that is gone fails the
purchase, which the buyer can retry. A merchant whose worker draws an order
later than the patience can get one extra hand-over per sweep, which is why the
patience is configurable.

## Alternatives rejected

An outbox table would be a second queue beside pg-boss, whose job table is
already a durable record of intent written in the state's own transaction.
Running effects before the commit hands a merchant an order that may roll
back; the one exception is the payout wallet change (ADR-0019), announced
before it is recorded, because there an unannounced change is the dangerous
failure. Leaving the gap and naming it holds only while no payment is real.
