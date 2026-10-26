# The purchase door refuses before any charge

Status: approved by the product owner on 2026-10-21 as proposed: a limit on
purchases waiting for payment, ten minutes of silence, thirty days. On
2026-10-26 the product owner set the limit at fifty for now.

## Context

Every unpaid purchase opens an order and, for a card with a price check, asks
the merchant's code or shop its price; a WooCommerce shop is called about a
dozen times per price. Nothing limited that, so anyone could load a merchant's
shop through Agentify, or get Agentify's address banned by the shop's firewall,
after which every sale fails. A card charged before its goods also kept taking
money while the merchant's own process was down. And every purchase priced and
never paid stays a row for ever, which every list of a merchant's orders reads.

## Decision

A merchant has at most fifty purchases priced and waiting for payment at once.
The fifty-first unpaid purchase is refused before its price is asked, with HTTP
429, a `Retry-After` and `seller_busy`, and nothing is written for it. The
count and the write are one step on the merchant's row. Whoever keeps fifty
unpaid purchases open stops that merchant's sales through Agentify while they
do, and nothing beyond the fifty reaches their shop. The product owner does not
accept that cost (2026-10-26): nobody should be able to stop a merchant's sales
without paying. Fifty is the product owner's number for now. It lets more
honest buyers past the door, though a slow price handler or shop answers fewer
of them in time, and it lets a hold put more load on a shop; it does not answer
that objection, which stays open in [the research on unpaid price
questions](../research/87-unpaid-price-questions.md).

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
its buyer and nothing presented to pay with is deleted thirty days after it was
last written, by a daily job in bounded batches, unless a receipt or a payment
claim names it. Its buyer's key is then answered as one that names no order.
Nothing with money, a claim, a receipt or goods is deleted.

## Alternatives rejected

A limit per buyer or per address: an agent has no identity at the door, and
addresses are cheap. A limit counted in memory: two processes, or two requests
at once, would both pass it. Stopping a silent merchant's selling as a pause:
it would have to be resumed by hand, and a merchant whose process restarts in
a minute would find their sales stopped. Recording contact on every call with
the merchant's key: a publishing script would count as a running worker.
Keeping lapsed attempts and only hiding them: the table and every read of it
grow without bound.
