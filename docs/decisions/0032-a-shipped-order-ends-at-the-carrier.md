# 0032. A shipped order ends at the carrier, and the agent is told `shipped`

Date: 2026-09-28
Status: accepted (Dmitry, 2026-09-28: «Полностью согласен»); the revisions of
two review rounds await his word. Not built yet.

## Context

The asynchronous mode carries goods that leave later: the money moves at the
purchase, the merchant delivers by a separate call before a deadline, and a
missed deadline or a refusal after the charge leaves a refund owed (ADR-0028).
Its words assume goods that are the agent's once handed over: `delivered` ends
the order, issues the receipt and stops every clock. A merchant who ships a
parcel knows only that a carrier took it. The deadline falls to a day the agent
never sees, nothing caps it, nothing tells the agent where to ask about goods
that have left, and the pilot pays in advance only for goods that survive a
second delivery (`apps/docs/index.md`), which a parcel does not.

## Decision

A card for shipped goods says `fulfillment: 'ship'`. Until the shipment it is
the asynchronous mode for money. The machine gains no state; its mode gains a
switch, taken by the order at purchase, that the goods are a parcel, so a
republished card changes no order in flight. The card asks for `ship_to`
(ADR-0031), has a price check answered by the merchant's handler, and names
`ship_within_seconds`: the time to hand the parcel to a carrier, counted from
the charge, under a ceiling written in the contract and checked at publishing,
shown on the card and as an absolute `ship_by` on the order. A merchant who
sells parcels names once, in the cabinet, where buyers ask; the order's status
carries it, and no `ship` card publishes without it.

The merchant declares no result. `deliver` on a parcel records a shipment:
`carrier` and `tracking_number`, required and taken as the merchant's claim,
and optionally `tracking_url` and `estimated_delivery` (names, and what an
integrator learns, in the research note). The order then reads `shipped` to
the agent, to the merchant and on the receipt: the parcel is with the carrier,
the money with the merchant, and this is the last word about the parcel, which
the status's description says because every protocol using the word goes on
past it. The discovery listing shows
`ship_to` and a shipment, with a real example: the company's own address and a
carrier's published test number. `ship` and `shipped` join the storefront's
open vocabularies (ADR-0006 §5), and the SDK's contract version moves.

What becomes of the parcel afterwards is between buyer and merchant. When a
merchant admits a parcel lost, ADR-0028's command records a refund on the
shipped order, which the receipt then reads — the machine's one edge out of
`delivered`, for parcels only. A `ship` card publishes on the test channel and
is refused on the live one, with words, until that command and ADR-0028's view
of the payer run there and ADR-0011 carries its verdict on shipments behind the
order identifier.

## Consequences

The agent is told what we know and no more, on money paths already tested. A
lost parcel is invisible to us until the merchant says so. A merchant without
tracking cannot use this mode, and learns it at publishing. The price check's
"unavailable" also means "not to this destination", and `rejected` says so. An
order is one parcel of one card, and a parcel is not safe to ship twice, so
keying on the order identifier stops being advice. Duties, restricted goods,
returns, a changed address and pickup points are outside the mode for now
(Dmitry, 2026-09-28).

Rejected: `delivered` with a caveat on the card (the status read alone would
claim arrival); an arrival state with its own deadline (merchants rarely know
arrival, and debts would fall on parcels at the door); a result each merchant
declares (no agent learns every shape); a second `deliver` to update tracking
(the call keeps the first delivery in every mode); optional tracking (the
merchant's word alone would stop the clock); reusing `fulfill_deadline_seconds`
(one name, two meanings); a ceiling in deployment configuration (unseen by the
offline check); a contact per shipment (absent before it and on a debt);
reopening a lost parcel into a debt (a stale delivery would close it); a
"physical" flag beside `fulfillment` (two fields for one fact; a parcel
confirmed by hand waits for ADR-0007's trigger).
