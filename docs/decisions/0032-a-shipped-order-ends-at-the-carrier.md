# 0032. A shipped order ends at the carrier, and the agent is told `shipped`

Date: 2026-09-28
Status: accepted (Dmitry, 2026-09-28: «Полностью согласен»); the revisions of
two review rounds await his word. Not built yet.

## Context

The asynchronous mode carries goods that leave later: the money moves at the
purchase, the merchant delivers by a separate call before a deadline, and a
missed deadline or a refusal after the charge leaves a refund owed (ADR-0028).
Its words assume goods that reach the agent the moment they are handed over:
`delivered` ends the order, issues the receipt and stops every clock. A
merchant who ships a parcel knows only that a carrier took it. The deadline
falls to a day the agent never sees, nothing caps it, nothing tells the agent
where to ask about goods that have left, and the pilot pays in advance only for
goods that survive a second delivery (`apps/docs/index.md`), which a parcel
does not.

## Decision

A card for shipped goods says `fulfillment: 'ship'`. Until the shipment it is
the asynchronous mode for money. The machine gains no state; its mode gains a
switch saying the goods are a parcel, which the order takes at purchase, so a
republished card changes no order in flight. The card asks for `ship_to`
(ADR-0031), has a price check answered by the merchant's handler, and names
`ship_within_seconds`: the time to hand the parcel to a carrier, counted from
the charge, under a ceiling written in the contract and checked at publishing,
shown on the card and as an absolute `ship_by` on the order. No `ship` card
publishes until its merchant has named their shop's site, where the agent takes
whatever the order cannot answer (ADR-0033).

The merchant declares no result. `deliver` on a parcel records a shipment: the
`carrier`, required, a short plain-text string — a carrier's name, or the
shop's own courier — and, where they exist, `tracking_number`, `tracking_url`
and `estimated_delivery` (names, and what an integrator learns, in the research
note). A shipment without a tracking number says so, never by an empty field.
All of it is the merchant's claim, which we do not check. The order then reads
`shipped` to the agent, to the merchant and on the receipt: the parcel is with
the carrier, the money with the merchant, and this is the last word about the
parcel. The status's description says so, because every protocol using the word
goes on past it. The discovery listing shows `ship_to` and a shipment, with a
real example: the company's own address and a carrier's published test number.
`ship` and `shipped` join the storefront's open vocabularies (ADR-0006 §5), and
the SDK's contract version moves.

What becomes of the parcel afterwards is between buyer and merchant. When a
merchant admits a parcel lost, ADR-0028's command records a refund on the
shipped order — the machine's one edge out of `delivered`, for parcels only —
and the receipt then reads the refund. A `ship` card publishes on the test
channel and is refused on the live one, with words, until that command and
ADR-0028's view of the payer run there and ADR-0011 carries its verdict on
shipments behind the order identifier.

## Consequences

The agent is told what we know and no more, on money paths already tested. A
lost parcel is invisible to us until the merchant says so. A shop's own
courier, with no tracking, can sell through this mode; `shipped` then rests on
the merchant's word, as it would on a number nobody checks. The price check's
"unavailable" also means "not to this destination", and `rejected` says so. An
order is one parcel of one card, and a parcel is not safe to ship twice, so
keying on the order identifier stops being advice. Duties, restricted goods,
returns, a changed or mistyped address and pickup points are outside the mode
for now (Dmitry, 2026-09-28).

Rejected: `delivered` with a caveat on the card (the status read alone would
claim arrival); an arrival state with its own deadline (merchants rarely know
arrival, and debts would fall on parcels at the door); a result each merchant
declares (no agent learns every shape); a second `deliver` to update tracking
(the call keeps the first delivery in every mode); a required tracking number
(it shuts out local couriers and invites made-up numbers, and one we cannot
check proves no more than the word); a list of carriers (every town has its
own); reusing `fulfill_deadline_seconds` (one name, two meanings); a ceiling in
deployment configuration (unseen by the offline check, and a lowered one
strands published cards above it); a support contact of ours, per shipment or
per merchant (ADR-0033 sends the agent to the shop's site instead); reopening a
lost parcel into a refund owed (a stale delivery would close it); a "physical"
flag beside `fulfillment` (two fields for one fact; a parcel confirmed by hand
waits for ADR-0007's trigger).