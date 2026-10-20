# 0033. A shipped order ends at the carrier, and the agent is told `shipped`

Date: 2026-09-28
Status: accepted (the product owner, 2026-09-28 and 2026-10-09). Built, and
sold on the test channel only. Merchant closure is governed by ADR-0028.

## Context

The asynchronous mode sells goods that leave after the charge, and a missed
deadline leaves fulfillment overdue (ADR-0028). Its `delivered` assumes goods
that reach the agent when handed over: it ends the order, issues the receipt and
stops every clock. A merchant who ships a parcel knows only that a carrier took
it, and the pilot pays in advance only for goods that survive a second delivery
(`apps/docs/index.md`), which a parcel does not.

## Decision

A card for shipped goods says `fulfillment: "ship"`, and money moves as in the
asynchronous mode until the parcel ships. The order records at purchase that it
is a parcel, or the result it was sold with where it is not, so a republished
card changes no order in flight, and the state
machine gains no state. The card names `ship_within_seconds`, the time to hand
the parcel to a carrier from the charge, capped at thirty days in the contract,
which the agent reads on the card and as the absolute `ship_by` on the order.
The mode fixes the rest: no declared `result` or delivery deadline, the address
carried by the purchase (ADR-0032), and the whole price with shipping asked of
the merchant's price handler. Its merchant must have given their shop's site
(ADR-0034), where a buyer asks about a parcel.

`deliver` on a parcel records a shipment, its tracking number `null` where
there is none: the merchant's claim, which we do not check, stamped by the
gateway with when it was recorded. The same shipment sent again is answered as
already recorded, and a different one is refused, because a recorded shipment
cannot be changed; the merchant deduplicates shipping on the order identifier.
The order's internal state is then `delivered`, and it reads `shipped` to the
agent, to the merchant and on the receipt: the parcel is with the carrier and
the money in the merchant's split (ADR-0037), and that is the last word
Agentify has about it. The agent's status carries the shipment beside a
`delivered` that stays `null`, because nothing reached the agent.

The discovery listing's example purchase ships to Agentify's own office, a real
place and nobody's home. `ship` and `shipped` join the storefront's open
vocabularies (ADR-0006 §5), and the contract version does not move, as no
merchant outside our control runs a published SDK yet (ADR-0006 §2).

A lost parcel and any refund or other agreement remain the merchant's
responsibility. Agentify records no verified refund or settlement of that
agreement (ADR-0028). The live channel continues to refuse a `ship` card until
the merchant closure flow and its public contract are implemented, reviewed
and tested, and the other parcel readiness gates hold. Closure applies only
before shipment is recorded: an already-shipped parcel keeps its shipment and
receipt, and any subsequent agreement stays outside Agentify. Who may read a parcel's tracking is
ADR-0011's rule: the holder of the order identifier, which no payment
requirement or listing carries.

## Consequences

The agent is told what we know and no more, on money paths already tested. A
lost parcel is invisible to us until the merchant says so. A shop's own courier
can sell without tracking, and `shipped` then rests on the merchant's word, as
it would on a number nobody checks. An order is one parcel of one card, and
duties, returns, a changed address and pickup points have no handling.

Rejected: `delivered` with a caveat on the card (the status read alone claims
arrival); an arrival state with its own deadline (merchants rarely know
arrival, and debts would fall on parcels at the door); a result each merchant
declares (no agent learns every shape); a second shipment accepted in silence
(a correction would vanish without a word); a required tracking number (it
shuts out local couriers and invites made-up numbers); reusing
`fulfill_deadline_seconds` (one name, two meanings); a ceiling in deployment
configuration (unseen by the offline check, and a lowered one strands published
cards); reopening a lost parcel for fulfillment (a stale delivery would
close it); a "physical" flag beside `fulfillment` (two fields, one fact).
