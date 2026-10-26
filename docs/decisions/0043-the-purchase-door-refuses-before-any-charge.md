# The purchase door refuses before any charge

Status: the limit on purchases waiting for payment and the ten minutes of
silence are the product owner's (2026-10-21), and so is fifty as the limit for
now (2026-10-26). His word of 2026-10-26: "the catalog does not show a
seller's cards while that seller is not taking orders; the cards come back by
themselves when the seller is in touch again." It names the seller, not a
payment mode, so a silent seller's synchronous cards leave the catalogue too.
Refusing them at the door, and keeping a silent seller's look answered with
its challenge, are the engineering consequences.

## Context

Every unpaid purchase opens an order and, for a card with a price check, asks
the merchant's code or shop its price; a WooCommerce shop is called about a
dozen times per price. Nothing limited that, so anyone could load a merchant's
shop through Agentify, or get Agentify's address banned by the shop's firewall,
after which every sale fails. A card charged before its goods also kept taking
money while the merchant's own process was down.

## Decision

A merchant has at most fifty purchases priced and waiting for payment at once.
The fifty-first unpaid purchase is refused before its price is asked, with HTTP
429, a `Retry-After` and `seller_busy`, and nothing is written for it. The
count and the write are one step on the merchant's row. Whoever keeps fifty
unpaid purchases open stops that merchant's sales through Agentify while they
do, and nothing beyond the fifty reaches their shop. The product owner does not
accept that cost (2026-10-26), since nobody should be able to stop a
merchant's sales without paying; the objection stays open in [the research on
unpaid price questions](../research/87-unpaid-price-questions.md).

Every purchase of a merchant is refused with `seller_not_taking_orders` while
no process of the merchant's own code has polled for ten minutes, at the
unpaid request and again before its first payment is verified; a payment that
releases goods already made goes through. A synchronous purchase would charge
nothing, but nobody would draw its order, so it could only lapse after the
buyer had signed and waited. It is not a pause: nothing is stored to resume,
the first poll lets the next purchase through, and cards the merchant paused
stay paused. Contact is a poll of the merchant's own code, recorded per
merchant at most every thirty seconds per process and kept in the database so
that a restart refuses nobody; the rule allows for that half minute. A process
whose handlers are all busy does not poll and counts as quiet. A merchant
selling through the WooCommerce connector is never refused for this, because
the connector runs inside Agentify.

The public catalogue lists a card only where the door would price it, by one
rule both read, so a silent merchant's cards leave it and come back by
themselves. A look at such a card, the unpaid GET that discovery crawlers
read, still answers with its challenge, so a listing other people run does not
drop it for a pause ([ADR-0012](0012-discovery-declaration.md)). A merchant at
the limit of fifty stays listed: a place frees within a minute, and anybody
could fill the fifty without paying.

`seller_busy` and `seller_not_taking_orders` are retryable. The second depends
on the merchant's process coming back, but that return is enough, with nobody
switching anything on, and a refused purchase charges nothing, so a retry costs
the buyer nothing.

## Alternatives rejected

A limit per buyer or per address: an agent has no identity at the door, and
addresses are cheap. A limit counted in memory: two processes, or two requests
at once, would both pass it. Stopping a silent merchant's selling as a pause:
it would have to be resumed by hand, and a merchant whose process restarts in
a minute would find their sales stopped. Recording contact on every call with
the merchant's key: a publishing script would count as a running worker. A
field on each catalogue card saying whether it can be bought now: it grows the
public surface, when leaving the card out says the same.
