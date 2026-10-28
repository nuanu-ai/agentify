# 0032. A buyer's address passes through Agentify and is erased at handover

Status: accepted by the product owner on 2026-09-28; updated with the
stateless-price design on 2026-10-27.

## Context

A parcel needs a destination. Agentify needs the full address only until the
merchant has it; retaining it afterward adds personal data without helping
fulfillment. Research: [physical goods](../research/37-physical-goods.md).

## Decision

A parcel takes `ship_to` beside `params`: `name`, `line_one`, `line_two`, `city`,
`state`, `postal_code`, `country` and `phone_number`. Other products refuse it.
The door checks the common shape; the merchant decides where it ships and
which state or postal code its carrier needs.

A price question carries only country, state, city and postal code. The full
address is not stored at pricing. The authenticated price stamp binds a keyed
digest of locality (ADR-0049). The buyer repeats the complete address at payment;
first verified ownership freezes it within that locality. Invalid signatures
freeze nothing. Private comparisons are not disclosed before verification or,
for an owned order, before ownership is established.

The merchant stores the paid address before answering `accepted` or the
`accept` call. Agentify erases its copy at the first of: acceptance, recorded
shipment, closure, or unfulfilled delivery without acceptance (ADR-0028).
Durable order envelopes carrying the address are removed; price questions are
transient and leave the queue when their wait ends. Events and deadline
reminders carry no address and remain. An erased parcel reads
`ship_to: { "erased_at": ... }` and is never handed to a handler again.
A connector holds the full address no longer than the gateway does. Its bounded
cart-resource registry retains encrypted idle tokens, not the full address.
Those shop sessions can retain the last priced locality until WooCommerce
expires them; their creation bound and ownership are recorded in ADR-0023.

The full address leaves no masked fragment or fingerprint. The retained stamp
still contains its keyed locality digest to authenticate the original price.
No error leaving the store or queue carries bound parameter values, and logs
contain no address. Free-form purchase parameters remain with the order; a
merchant must not put an address into those parameters or into free text.

Erasure reaches the channel database. Earlier live backups retain what they
captured, usually for about sixty days without a fixed upper bound (ADR-0029).
Release restore points on either channel last until five newer releases replace
them. The portal and contract state this wherever they promise erasure.

## Alternatives rejected

An address inside merchant-defined parameters gives no common erasure boundary.
A full address in a price question exposes it for purchases never made. Keeping
the full address until shipment retains it for days after handover. Agentify
cannot reconstruct a lost merchant copy or adjudicate where a parcel went.
