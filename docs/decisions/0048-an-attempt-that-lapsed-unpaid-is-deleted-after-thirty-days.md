# An attempt that lapsed unpaid is deleted after thirty days

Status: approved by the product owner on 2026-10-21 as proposed, thirty days
included.

## Context

Every unpaid purchase opens an order, and every purchase priced and never paid
stayed a row for ever, which every list of a merchant's orders reads. The
limit on purchases waiting for payment
([ADR-0043](0043-the-purchase-door-refuses-before-any-charge.md)) bounds how
many are open at once, not how many pile up.

## Decision

An order that ended rejected or expired with nothing charged, nothing held for
its buyer and nothing presented to pay with is deleted thirty days after it was
last written, by a daily job in bounded batches, unless a receipt or a payment
claim names it. Its buyer's key is then answered as one that names no order.
Nothing with money, a claim, a receipt or goods is deleted.

## Alternatives rejected

Keeping lapsed attempts and only hiding them: the table and every read of it
grow without bound.
