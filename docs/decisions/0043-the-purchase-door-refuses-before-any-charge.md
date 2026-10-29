# The purchase door refuses before any charge

Status: the ten minutes of silence are the product owner's (2026-10-21). His
word of 2026-10-26: "the catalog does not show a seller's cards while that
seller is not taking orders; the cards come back by themselves when the seller
is in touch again." It names the seller, not a payment mode or an integration,
so a silent seller's synchronous cards leave the catalogue too. Refusing them
at the door, keeping a silent seller's look answered with its challenge, and
holding a shop to the connector's polls are the engineering consequences. His
words of 2026-10-27 replace the limit of fifty purchases waiting for payment:
"A request nobody paid for may use a moment of a merchant's capacity and holds
nothing over time" and "Work that is paid for
never waits behind work that is not"; one merchant's load must not slow
another's either. The gates, the lanes and their counts are engineering
choices, not measured capacity
([research 90](../research/90-unpaid-price-questions-design.md)).

## Context

A card with a price check asks the merchant's code or shop for every price, and
a WooCommerce shop is called about a dozen times per price. Unbounded, anyone
could load a merchant's shop through Agentify or get Agentify's address banned
by the shop's firewall, after which every sale fails. A limit of fifty unpaid
purchases bounded that, but whoever kept fifty open stopped the merchant's
sales without paying. A card charged before its goods also kept taking money
while the merchant's own process was down.

## Decision

An unpaid purchase writes nothing (ADR-0049), so nothing is counted over time.
Each merchant has a gate for price questions, shared by the SDK and
WooCommerce, and two lanes for payment checks, each with a few places and a
short line; ready paid orders and events reach the merchant ahead of price
questions. A merchant has ten seconds to answer a price question: "да, 10
секунд нормально" (yes, ten seconds is fine), the product owner, 2026-10-28. A
question with no place in time sells a synchronous card at its card price, as
a silent merchant's does, and answers a card paid before delivery with
`seller_busy`, HTTP 429 with `Retry-After: 2`; one left unanswered there gets
`Retry-After: 10` and says the price check may not be answering. A merchant's
"unavailable" answers `not_selling`, not retryable.

A payment whose EIP-3009 signature recovers to the wallet it names waits in
the buyer lane. Any other, a contract wallet's among them, and a key's payment
whose wallet the chain could not tell about, wait in a smaller lane, never
ahead of a buyer whose key signed. In either lane one payer, the wallet that
signed or else the one the payment names, holds at most one place and one place
in line per merchant. What the token would refuse is refused before any lane:
an authorization not valid yet, a key's high-s signature and, from the chain, a
used nonce or a balance below the price; getting a paid purchase back is never
judged by the balance. A full line, or no place within two seconds, answers
`seller_busy` with `Retry-After: 2`. The facilitator still judges validity, and
one merchant's work never takes another's places.

These counts are kept in memory, which this decision once rejected because two
processes, or two requests at once, would both pass such a limit. They now
bound only work in progress, never anything stored or owed; one process admits
callers one at a time, and each channel runs one gateway process. A second
process is the exit trigger, as in ADR-0049.

Every purchase is refused with `seller_not_taking_orders` while nothing has
polled for ten minutes for the integration the merchant sells through: a
compatible process of their own code, or the WooCommerce connector, which
polls for a shop only while it is connected. The refusal comes before pricing
and again before the first payment is verified; a payment that releases goods
already made goes through. A recorded poll names the integration that made
it and counts only while the merchant sells through that one. Nothing is
stored to resume: the first compatible poll lets the next purchase through. The catalogue lists a card
only where the door would price it, while a silent merchant's card still
answers its unpaid GET with its challenge, so an outside listing keeps it
(ADR-0012). A busy merchant's cards stay listed. `seller_busy` and
`seller_not_taking_orders` are retryable and charge nothing.

## Alternatives rejected

Fifty unpaid purchases per merchant: anyone could hold all fifty and stop sales
without paying. Counting the connector in touch whenever Agentify runs: a
shop with none connected (ADR-0036) stayed listed, answering `seller_busy`.
Asking the dashboard whether a shop is connected: it misses a connector that
stopped polling. A limit per buyer or per address on price questions: an
agent has no identity before it pays, and addresses are cheap. Stopping a silent
merchant's selling as a pause: it would need resuming by hand after an ordinary
restart. Recording contact on every call with the merchant's key: a publishing
script would count as a running worker. A field on each catalogue card saying
whether it can be bought now: it grows the public surface, when leaving the
card out says the same. Fair shares between sources, a room for agents vetted
by directories, a lane for agents that sign before the price, reserved worker
capacity and Cloudflare in front: kept for when abuse or a merchant whose gate
is often full is seen, and Cloudflare only with per-address limits, since its
challenges refuse agents, which are programs.
