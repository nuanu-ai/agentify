# 0027. A silent charge remains unresolved without payment evidence

Date: 2026-09-22
Status: accepted (self-service boundary: the product owner, 2026-10-19).
Automatic reconciliation is not built. The existing `report-payment`
maintenance command records an unchecked assertion and is not a self-service
or supported customer recovery path.

## Context

A settle that times out may have moved money. The facilitator client can
verify, settle and list what it supports; it cannot query the outcome of an
already submitted charge. Asking it to settle again risks another charge.
Agentify has no person assigned to investigate these orders.

## Decision

The public status of a charge with an unknown outcome is `payment_unresolved`,
whether or not the order is still open. The system never treats silence as
proof of success or failure and never repeats a settle to find out.

Recovery must use evidence that can be checked against the original payment
attempt: its network, asset, payer, recipient, amount and payment authorization.
A transaction hash alone, an administrator's permission, or a merchant's claim
is insufficient. Missing evidence and a failed lookup leave the outcome
unknown. A failure may not be recorded where it would permit a second charge
without proof that the first cannot execute.

Any recovery must serialize with the original settle result. A deadline can
mark the outcome unknown while the original call is still in flight. Evidence
from a previous attempt cannot resolve the current one. The payment-layer
header is reserved for that layer's answer. A receipt needs an observed payment
time; a person submitting evidence does not supply one by pressing a button.

`open=true` is the list a restarted merchant worker walks. An order that was
priced and never paid, and never reached the handler, is not on it. Its buyer
status remains `in_progress`. An unresolved payment is not work that a merchant
handler should retry as another charge.

## Implementation boundary

`report-payment` can assert success without reading the chain. It waits for
the current settle call to return and refuses a failure on an open order, but
those guards do not prove money moved. It marks the assertion in the payment
record and supplies neither a payment-layer receipt nor an observed payment
time. It stays a privileged maintenance tool, outside merchant and admin web
flows; nobody is promised that a person will run it. Replacing it with verified
reconciliation is open in `docs/research/52-self-service.md`.

## Alternatives rejected

A second settle; a success or failure button without verification; a customer
support queue as the required way out; and a receipt stamped with the time
somebody inspected the order. Each converts uncertainty into a claim on which
someone else's agent can move money.
