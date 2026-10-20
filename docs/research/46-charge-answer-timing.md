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
charge then lands after all, the order becomes `unfulfilled`: the merchant
holds money for goods they were never asked to make. These orders
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
limit. On an order paid before its goods the purchase call does not wait on
the deadline at all: it waits for the facilitator's answer itself, bounded by
that thirty-second client.

The authorisation an agent signs has to outlive the charge as well. The x402
reference client signs one valid for the challenge's `maxTimeoutSeconds`,
counted on its own clock, rounded down to the second, from the moment it
signs, and the exact-EVM facilitator refuses an authorisation that ends within
six seconds, at the check and again at the charge. A synchronous charge goes
out once the merchant has answered, up to ten seconds after the order is
marked paid, which is a moment after the check, and then once the answer is
written. So at the check the gateway asks for the merchant's ten seconds, the
facilitator's six and two more for its own steps and the difference between
clocks, eighteen in all, and the challenge asks for the price's life on top
(thirty seconds, `QUOTE_TTL_MS`) and two more for the check's round trip and
the client's rounding: fifty seconds, worked out in
`apps/gateway/src/app/payment-window.ts`. The price's life is there for an
agent that signs as soon as the price is named and presents the payment as it
runs out; one that signs and sends at once needs only the eighteen. The two
allowances are chosen, not measured, and the transfers measured below land in
under three seconds. The price itself still lapses after thirty seconds, so
the number is not a time to pay in. An agent that holds a signed authorisation
past the price's life, whose clock runs slow, or whose check takes longer than
the allowance can still arrive with less than the charge needs; where the
goods are still to be made the gateway then refuses the payment at the check,
as `payment_not_verified`, before anything is made or charged, and the agent
pays the same order again with a fresh signature while the price holds. A
repeat purchase that collects goods already made is charged at once and is not
held to the eighteen seconds. The six-second rule was read in the open-source
facilitator code (`@x402/evm` 2.23.0) in this repository; whether the hosted
facilitators the channels settle through keep the same margin has not been
checked, and a check of the payment alone, with authorisations that end five
and seven seconds after it, would answer that without moving money.

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

How long the agents that buy here hold a signed authorisation before they
present it, and how far their clocks run, is not known.

Whether the two refunds owed on TEST were ever reconciled has not been
checked. The changes to the waits do not touch orders that already exist.
