# 0032. A shipped order ends at the carrier, and the agent is told `shipped`

Date: 2026-09-28
Status: accepted (Dmitry, 2026-09-28: «Полностью согласен» to the first draft).
Revised the same day after two rounds of adversarial review; the revisions
await Dmitry's word. Not built yet.

## Context

The asynchronous mode carries goods that leave later: the money moves at the
purchase, the merchant takes the order on and delivers by a separate call
before a deadline, and a missed deadline or a refusal after the charge leaves a
refund owed (ADR-0028). Its words assume goods that reach the agent the moment
they are handed over: `delivered` ends the order, issues the receipt and stops
every clock. A merchant who ships a parcel knows only that a carrier took it.
The delivery deadline falls to a day the agent is never shown and has no
ceiling, and nothing tells the agent where to ask about goods that have left.
The pilot pays in advance only for goods that survive being delivered twice
until a refund can be recorded (`apps/docs/index.md`); a parcel does not.

## Decision

A card for goods that are shipped says `fulfillment: 'ship'`. Until the
shipment it is the asynchronous mode for money. The machine gains no state, but
its mode gains a third switch — the goods are a parcel — which the order takes
at purchase, so republishing the card changes no order in flight, and which one
new edge reads: a refund recorded on a shipped order (below). The card carries
a price check answered by the merchant's handler, because the destination
decides the cost and whether they ship there at all. It names
`ship_within_seconds`, the time to hand the parcel to a carrier, counted from
the charge and held under a ceiling written in the contract beside the price
rule and checked when the card is published. The agent reads it on the card
and, as an absolute `ship_by`, on the order's status. A merchant who sells
parcels names once, in the cabinet, where buyers ask about their orders; a
`ship` card is not published without it, and the order's status carries it.

The merchant declares no result. `deliver` on a parcel records a shipment of
the contract's shape: `carrier` and `tracking_number`, which are required, and
`tracking_url` and `estimated_delivery` with `earliest` and `latest`
(`docs/research/37-physical-goods.md`). The requirement is said where the card
is published, and the number is the merchant's claim, which we do not check.

A recorded shipment reads `shipped` — to the agent, to the merchant and on the
receipt: the parcel is with the carrier and the money with the merchant. It is
the last word about the parcel, and the order moves again only if a refund is
recorded, which the receipt then reads as well. The status's own description
says so, because in every protocol that uses the word it is not the last one.
The discovery listing carries `ship_to` in its input schema and the shipment in
its example output, with a real address, the company's own, and a carrier's
published test tracking number. `ship` and `shipped` are the first values added
to the storefront, which has no version and reads them under ADR-0006 §5; the
SDK's contract version moves (ADR-0006).

What becomes of the parcel afterwards is between the buyer and the merchant.
ADR-0028's command also records a refund on a shipped order whose parcel the
merchant admits lost — the machine's one edge out of `delivered`, for parcels
only — and ADR-0028's view of the payer's address covers a shipped order too.
A `ship` card publishes on the test channel and is refused on the live one,
with words naming the reason, until both of those are running there and
ADR-0011 carries its revisit's verdict on a shipment readable by whoever holds
the order identifier.

## Consequences

The agent is told what we know and no more, on a machine whose money paths are
tested, and the path can be shown before a merchant asks for it. A lost parcel
is invisible to us until the merchant says so. A merchant who delivers without
tracking — by their own courier — cannot sell through this mode, and is told so
before selling. The price check's "unavailable" now also means "not to this
destination", and `rejected`'s description says so; a reason on it is open. An
order is one parcel of one card. A parcel cannot safely be shipped twice, so
keying on the order identifier stops being advice. What a merchant's engineer
learns is inventoried in the research note, together with the pages that
change.

Rejected: `delivered` with a caveat on the card (an agent reading the status is
told a parcel in transit arrived); a second state with an arrival deadline
(merchants rarely know arrival, and the deadline would raise debts on parcels
already at the door); a result each merchant declares (no agent learns every
shape); a second `deliver` to update the tracking (the call keeps the first
delivery in every mode); tracking left optional (the merchant's word alone
would stop the clock); reusing `fulfill_deadline_seconds` (one name, two
meanings); a ceiling in the deployment's configuration (invisible to the
offline check, and a lowered one leaves cards above it); a contact on each
shipment (absent before shipment and on a refund owed); reopening a lost parcel
into a refund owed (a stale delivery on the open list would close the debt); a
"physical" flag beside `fulfillment` (two fields saying one thing; a parcel
confirmed by hand waits for ADR-0007's trigger).
