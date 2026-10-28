# A price travels with the buyer until payment

Status: the product owner approved the stateless price design on 2026-10-27,
including a generic merchant calculation reference and removal of compatibility
paths. Details and alternatives: [research](../research/90-unpaid-price-questions-design.md).

## Context

Creating an order for every unpaid price lets a caller consume storage and hold
places in a merchant's admission limit without buying anything. A price still
has to hold until its stated end, and one price must never become two orders.

## Decision

An unpaid purchase creates no durable order, queue job or calculation ledger.
The 402 carries the normal x402 amount and an opaque `extra.price_stamp`,
authenticated with HMAC-SHA256 under a channel secret. A price question exists
only while its HTTP caller waits; a gateway restart ends that wait.

The stamp binds a unique price identifier, merchant and integration, published
card and policy, canonical purchase parameters, parcel locality, price source,
amount, currency, original token and signature domain, payee, authorization
window and price term. Private parameters and locality use keyed digests. It
contains neither a buyer key nor a full address. The client repeats its JSON
body and returns the stamp through x402's ordinary paid retry.

At payment, the gateway authenticates the stamp and judges its term at the
arrival of the complete paid request. It creates one order, with a stable
identifier derived from the price identifier, before verification. Repeated or
concurrent submissions preserve that order and its buyer key. An invalid
signature establishes no owner, address or payment claim. First verified
ownership freezes the complete parcel address within the priced locality.

Engineering choice: an unconsumed offer is refused if the published card or
policy changes. Once accepted, its saved financial terms govern verification,
execution and recovery. A paid return uses the exact saved stamp and a fresh
owner signature even after the price expires or its signing key is retired;
the original used authorization remains forbidden.

A merchant may return `quote_reference`, an opaque bounded confirmation of its
calculation. Agentify authenticates it in the stamp and returns it unchanged
on the order. Its content is visible to the buyer in the 402: no secrets or
personal data belong in it. Core contracts contain no connector-specific rules;
a connector's needs alone do not justify widening them. No quote ledger remains.

## Alternatives rejected

Repricing at payment breaks the promised term and asks the merchant twice.
Keeping unpaid orders preserves free storage growth. A client-created private
order key adds a buyer obligation unrelated to bounding unpaid work. The buyer
example keeps the original challenge for recovery instead (ADR-0011).
