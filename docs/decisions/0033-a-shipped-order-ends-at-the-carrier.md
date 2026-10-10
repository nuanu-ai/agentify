# 0033. A shipped order ends at the carrier, and the agent is told `shipped`

Date: 2026-09-28
Status: accepted (the product owner, 2026-09-28 and 2026-10-09). Built, and
sold on the test channel only; the refund of a lost parcel is not built.

## Context

The asynchronous mode sells goods that leave after the charge, and a missed
deadline leaves a refund owed (ADR-0028). Its `delivered` assumes goods that
reach the agent when handed over: it ends the order, issues the receipt and
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
the money with the merchant, and that is the last word Agentify has about it.
The agent's status carries the shipment beside a `delivered` that stays `null`,
because nothing reached the agent.

The discovery listing's example purchase ships to Agentify's own office, a real
place and nobody's home. `ship` and `shipped` join the storefront's open
vocabularies (ADR-0006 §5), and the contract version does not move, as no
merchant outside our control runs a published SDK yet (ADR-0006 §2).

When a merchant admits a parcel lost, ADR-0028's command records a refund, and
the order moves from `delivered` to `refunded`, the only way out of `delivered`
and for parcels only, with the receipt reading the refund. Neither is built, so
the live channel refuses a `ship` card with words until that command and
ADR-0028's view of the payer run there, the dashboard tells a merchant how to
report a refund, and ADR-0011 rules on who may read a parcel's tracking.

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
cards); reopening a lost parcel into a refund owed (a stale delivery would
close it); a "physical" flag beside `fulfillment` (two fields, one fact).
