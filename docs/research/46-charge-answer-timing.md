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
seconds sits right where the transfers land.

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
checked out. That worst case can also end differently. The call's own wait is
counted from the payment checking out, the merchant's ten seconds from the
moment the order was marked paid a few milliseconds later, and the charge's ten
from the moment the merchant's answer was processed; and the reminder that
declares a charge silent comes off a queue that looks for due reminders every
half second, so it can land up to half a second after its deadline. A merchant
who answers in the last half second of their time and a charge that stays
silent can therefore leave the charge undecided when the call's wait ends, and
the agent then hears `in_progress` with the order's status address. That is
true while the charge is in flight, and the status address reads
`payment_unresolved` once the reminder lands.

The product owner decided this division on 2026-10-14. The two-second wait the
synchronous charge had before sat in the middle of the measured transfers, and
the ceiling was raised to twenty seconds rather than taking time from the
merchant. The merchant's answer went from eight seconds to ten in the same
decision. A longer deadline loosens the promise a handler was written against:
a handler that answered inside eight seconds answers inside ten, so no
merchant integration has to change.

Nothing else on the synchronous path assumes a shorter wait. The HTTP client of
`@x402/core` (version 2.23.0) times a facilitator call out after thirty seconds
by default, and the gateway does not change that. Neither Caddy configuration
in `deploy/` sets a proxy timeout, and the merchant's worker already holds a
poll open for twenty-five seconds through the same proxies. Node's own HTTP
server allows a request three hundred seconds, and the gateway sets no other
limit. The payment authorisation the agent signs stays valid for
`PAYMENT_TIMEOUT_SECONDS` from the moment it was signed, three hundred by
default. An agent signs inside the price's thirty-second life, the charge goes
out at most ten seconds after the payment checked out, and the facilitator call
that carries it is cut off after thirty, so all of it falls far inside that. On
an order paid before its goods the purchase call does not wait on the deadline
at all: it waits for the facilitator's answer itself, bounded by that
thirty-second client.

## What was measured

The figures come from read-only queries against the orders on TEST and on
production, made on 2026-10-12. Each transfer's time is the time of its block,
read from the block number because a block comes every two seconds, and it was
compared with the moment the gateway sent the charge. That is when the transfer
landed, not when the facilitator answered: the facilitator answers after the
block, so each figure is a lower bound on the answer. The gateway does not
record when the answer arrived; what it writes beside the order is stamped with
the moment the charge was sent.

On TEST, 31 transfers landed between 0.9 and 2.9 seconds after the charge was
sent, with a median of 1.9 seconds; 14 of them took two seconds or more. All of
these orders waited two seconds for the charge, because the fifteen-second wait
before the goods arrived only on 2026-10-12. Of the 21 charges made before the
goods, 2 were declared silent and became refunds owed that nobody owed. None of
the 13 synchronous charges was declared silent, which is not evidence that the
synchronous orders were safer: at the rate seen on the other orders about 1.2
of the 13 would be expected to go silent, and seeing none happens roughly a
quarter of the time. On production, the one live charge landed 2.7 seconds
after it was sent. A read of production's orders on 2026-10-12 found no order
in `refund_due` or `delivered_unpaid`, and none whose payment reads
`outcome_unknown`.

## What stays open

The samples are small: thirty-one transfers on a test chain and one on
production. They show where the transfers land on a quiet chain, not how
often a busy chain or a slow facilitator pushes an answer past ten seconds on a
synchronous order or past fifteen on one paid before its goods. Neither rate
has been measured, and measuring the answer itself needs the gateway to record
when it arrived.

An agent's own HTTP client may give up before twenty seconds. The ceiling is
what the gateway promises, and a client with a shorter timeout loses the answer
while the purchase goes on. The order's status address arrives inside that lost
answer, so such an agent learns how the purchase ended only by building the
status route the contract names from the order's identifier, which the payment
challenge carries. Which timeouts the agents that buy here actually use is not
known.

`PAYMENT_TIMEOUT_SECONDS` is three hundred by default, and the configuration
accepts any whole number of seconds above zero. A deployment set below about
seventy seconds could let a synchronous charge land after the authorisation
has expired (thirty seconds of the price's life, ten for the merchant, then up
to thirty for the facilitator call), which fails the charge after the goods
were delivered. No deployment overrides the default, and nothing at startup
refuses such a value.

Whether the two refunds owed on TEST were ever reconciled has not been
checked. The changes to the waits do not touch orders that already exist.
