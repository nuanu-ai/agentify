# A price travels with the buyer until verified acceptance

Status: the product owner approved stateless pricing on 2026-10-27, including a
buyer-visible generic calculation reference and removal of compatibility paths.
The review corrections implement the same no-unpaid-order rule. Reasoning and
engineering choices: [research](../research/90-unpaid-price-questions-design.md).

## Context

Creating an order for an unpaid price or an unverified signature lets a caller
consume storage and distort order analytics without buying. A price still holds
until its stated end, and one price must never become two purchases.

## Decision

Unpaid pricing creates no durable order, queue job or calculation ledger.
The 402 carries the normal x402 amount and opaque `extra.price_stamp`, bound by
HMAC-SHA256 to a channel secret. A price question exists only while its caller
waits; restart ends that wait. Contract version 6 removes `extra.order_id`.

The stamp binds the price identifier, merchant and integration, published card
and policy, canonical parameters, parcel locality, amount, currency, source,
timestamps, original chain/token/signature domain, payee and authorization
window. Parameters and locality use keyed digests. Neither a buyer key nor the
full address travels in it. The paid retry repeats its purchase body.

Verification precedes persistence. A transient admission lock serializes the
price through acceptance. Only successful verification may atomically commit
the owned order, nonce claim, jobs and order-created analytics on the same
connection holding that lock. External financial effects run after commit.
A lost lock connection cannot later create or charge its abandoned admission.

The price term is judged at arrival of the complete paid request. Verification
may finish later. A concurrent retry receives neutral, retryable advice to keep
and repeat that purchase; it is never told to buy again while the first request
may complete. Refusal guidance discloses no difference between paid and unpaid
records. Payment checks are bounded, including fixed prices and recovery.

Engineering choice: an unconsumed offer is refused if its card, policy,
integration or effective payee changes. Mutable eligibility is checked under
merchant/card locks at acceptance. Accepted purchases retain their exact saved
financial terms. First verified ownership freezes the full address within the
priced locality under the ownership lock. Failed verification freezes nothing.

A paid return uses the exact saved stamp and fresh owner proof after price
expiry or signing-key retirement; the original spent authorization is forbidden.
A payment signed from a listing without a stamp receives a fresh priced 402,
without verification or charge, through the ordinary purchase validation path.

A merchant may return bounded `quote_reference`, authenticated in the stamp and
returned unchanged on the order. The buyer can read it: no secrets or personal
data belong in it. Connector needs alone do not justify widening the contract.

## Alternatives rejected

Repricing at payment breaks the promised term and asks the merchant twice.
Persisting an unverified attempt still admits free storage growth; its former
thirty-day cleanup has no remaining production purpose and is removed. A client
private order key adds a buyer obligation unrelated to bounding unpaid work;
the buyer example saves the challenge for recovery instead (ADR-0011).
