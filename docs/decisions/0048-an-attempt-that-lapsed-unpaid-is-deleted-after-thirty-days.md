# Uncharged payment attempts are deleted after thirty days

Status: thirty-day retention approved by the product owner on 2026-10-21;
narrowed on 2026-10-27 with the rule that unpaid prices hold nothing over time.

## Context

An unpaid price creates no order (ADR-0049). Presenting a payment creates an
attempt before verification, so invalid or unanswered verification can leave
an unowned record. Rejected or expired attempts may also remain without money
or goods. They are not merchant work and must not accumulate forever.

## Decision

A daily job deletes eligible attempts thirty days after their last write, in
bounded batches under the order lock. Eligible means an ended rejected or
expired attempt, or an unverified admission whose original price has expired,
with no accepted payment, owner, recovery attempt, money, goods, payment claim
or receipt. Nothing financially accepted is deleted, including an unknown
payment outcome. First verified acceptance and deletion use the same order lock. Verification
runs outside it; if retention deletes an eligible unverified record while its
check is in flight, completion finds no order and executes no payment.

Unverified admissions are absent from the merchant's order list, restart walk
and integration-switch blockers. There is no merchant Lapsed segment. A deleted
buyer's key answers as one naming no order; presenting its expired stamp cannot
create a new charge.

## Alternatives rejected

Keeping expired unverified attempts forever grows the table for free. Hiding
rows without deleting them leaves that growth. Applying retention to unknown
payment outcomes would erase the evidence automatic recovery needs.
