# The purchase door refuses before any charge

Status: approved by the product owner, 2026-10-21, in this form and with these
numbers.

## Context

Every unpaid purchase opens an order and, for a card with a price check, asks
the merchant's code or shop its price; a WooCommerce shop is called about a
dozen times per price. Nothing limited that, so anyone could load a merchant's
shop through Agentify, or get Agentify's address banned by the shop's firewall,
after which every sale fails. A card charged before its goods also kept taking
money while the merchant's own process was down. And every purchase priced and
never paid stays a row for ever, which every list of a merchant's orders reads.

## Decision

A merchant has at most twenty purchases priced and waiting for payment at
once. The twenty-first unpaid purchase is refused before its price is asked,
with HTTP 429, a `Retry-After` and `seller_busy`, and nothing is written for
it. The count and the write are one step on the merchant's row. The cost is
accepted: whoever keeps twenty unpaid purchases open stops that merchant's
sales through Agentify while they do, but does not load their shop.

A purchase that charges before its goods is refused with
`seller_not_taking_orders` while no process of the merchant's own code has
polled for ten minutes, at the unpaid request and again before a payment is
verified. It is not a pause: nothing is stored to resume, the first poll lets
the next purchase through, and cards the merchant paused stay paused. Contact
is a poll of the merchant's own code, recorded per merchant at most every
thirty seconds per process and kept in the database so that a restart refuses
nobody; the rule allows for that half minute, so no merchant is refused before
ten minutes without a poll. A process whose handlers are all busy does not
poll and counts as quiet. A merchant selling through the WooCommerce connector
is never refused for this, because the connector runs inside Agentify, and a
synchronous purchase is not, because it ends uncharged when nobody answers.

`seller_busy` and `seller_not_taking_orders` are retryable. The second strains
the rule that a retry must not depend on somebody else acting, since it is the
merchant's process that has to come back. It is retryable because that return
is enough, with nobody switching anything on, and because a refused purchase
charges nothing, so a retry costs the buyer nothing.

An order that ended rejected or expired with nothing charged, nothing held for
its buyer, nothing presented to pay with and no confirmation asked of its
merchant is deleted thirty days after it was last written, by a daily job in
bounded batches, unless a receipt or a payment claim names it. Its identifier
is then answered as one that names no order. Nothing with money, a claim, a
receipt, an event or goods is deleted.

## Alternatives rejected

A limit per buyer or per address: an agent has no identity at the door, and
addresses are cheap. A limit counted in memory: two processes, or two requests
at once, would both pass it. Stopping a silent merchant's selling as a pause:
it would have to be resumed by hand, and a merchant whose process restarts in
a minute would find their sales stopped. Recording contact on every call with
the merchant's key: a publishing script would count as a running worker.
Keeping lapsed attempts and only hiding them: the table and every read of it
grow without bound.
