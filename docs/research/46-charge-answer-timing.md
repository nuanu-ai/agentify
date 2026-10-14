# How long the payment layer takes to answer a charge

Date: 2026-10-14. A research note that may be rewritten. It holds the
measurements behind the gateway's two waits for a charge,
`SETTLE_RESPONSE_MS` and `SETTLE_BEFORE_GOODS_MS`, the way the synchronous
ceiling promised to the agent is divided, and what those numbers still leave
exposed.

## What the waits are, and why

When the gateway sends a charge to the payment layer (the x402 facilitator), it
arms a deadline on the order. If no answer has come when the deadline passes,
the order machine declares the charge silent: the order's payment reads
`outcome_unknown`, which nobody can tell apart from a charge that never went
through. The facilitator answers only once the transfer is in a block, and Base
and Base Sepolia each make a block every two seconds, so a deadline of a few
seconds sits right where the answers arrive.

On an order paid before its goods (asynchronous, confirmed or a parcel), a
charge declared silent closes the order without dispatching it, and if the
charge then lands after all, the order becomes `refund_due`: the merchant holds
money for goods they were never asked to make, and owes it back. These orders
wait fifteen seconds for the charge (`SETTLE_BEFORE_GOODS_MS`).

On a synchronous order the merchant has already made the goods when the charge
is sent. A silent charge there answers the waiting agent with no goods and
`payment_unresolved`, sends the merchant `order.payment_failed_after_delivery`
once, and if the charge then lands, the order becomes delivered after the
agent's call has already returned. These orders wait ten seconds for the charge
(`SETTLE_RESPONSE_MS`).

The synchronous purchase has a ceiling the portal promises the agent, counted
from the moment the payment checked out: twenty seconds (`SYNC_BUDGET_MS`).
Inside it the merchant has ten seconds to answer with the goods
(`SYNC_RESPONSE_MS`) and the charge has the other ten. The gateway refuses to
start with a configuration whose answer and charge together exceed the
ceiling. The agent's purchase call waits for the ceiling, so in the worst case,
a merchant who answers at the end of their ten seconds and a charge that never
answers, the agent hears `payment_unresolved` twenty seconds after its payment
checked out. The call's own wait and the charge's deadline are counted from
instants a few milliseconds apart (the call's from the payment checking out,
the charge's from the moment the merchant's answer was processed), so in that
worst case the agent can instead hear `in_progress` with the order's status
address, which is true while the charge is in flight.

The product owner decided this division on 2026-10-14. The two-second wait the
synchronous charge had before sat in the middle of the measured answers, and
the ceiling was raised to twenty seconds rather than taking time from the
merchant. The merchant's answer went from eight seconds to ten in the same
decision. A longer deadline loosens the promise a handler was written against:
a handler that answered inside eight seconds answers inside ten, so no
merchant integration has to change.

Nothing else on the synchronous path assumes a shorter wait. The HTTP client of
`@x402/core` (version 2.23.0) times a facilitator call out after thirty seconds
by default, and the gateway does not change that. Neither Caddy configuration
in `deploy/` sets a proxy timeout, and Node's own HTTP server allows a request
three hundred seconds. The payment authorisation the agent signs stays valid
for `PAYMENT_TIMEOUT_SECONDS`, at least three hundred, so a charge sent in the
tenth second of a synchronous order is far inside it. On an order paid before
its goods the purchase call does not wait on the deadline at all: it waits for
the facilitator's answer itself, bounded by that thirty-second client.

## What was measured

The figures come from read-only queries against the orders on TEST and on
production. Each transfer's time was taken from its block number, which is
exact because a block comes every two seconds, and compared with the moment the
gateway sent the charge.

On TEST, 31 transfers landed between 0.9 and 2.9 seconds after the charge was
sent, with a median of 1.9 seconds; 14 of them took two seconds or more. Of the
21 charges made before the goods, 2 were declared silent and became refunds
owed that nobody owed. None of the 13 synchronous charges was declared silent,
which is not evidence that the synchronous orders were safer: at the rate seen
on the other orders about 1.2 of the 13 would be expected to go silent, and
seeing none happens roughly a quarter of the time. On production, the one live
charge landed 2.7 seconds after it was sent. A read of production's orders on
2026-10-12 found no order in `refund_due` or `delivered_unpaid`, and none whose
payment reads `outcome_unknown`.

## What stays open

The samples are small: thirty-one transfers on a test chain and one on
production. They show where the answers fall on a quiet chain, not how often a
busy chain or a slow facilitator pushes an answer past ten seconds on a
synchronous order or past fifteen on one paid before its goods. Neither rate
has been measured.

An agent's own HTTP client may give up before twenty seconds. The ceiling is
what the gateway promises, and a client with a shorter timeout loses the answer
while the purchase goes on; the order's status address still tells it how the
purchase ended. Which timeouts the agents that buy here actually use is not
known.

Whether the two refunds owed on TEST were ever reconciled has not been
checked. The changes to the waits do not touch orders that already exist.
