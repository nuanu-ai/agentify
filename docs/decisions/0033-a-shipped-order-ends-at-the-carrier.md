# 0033. A shipped order ends at the carrier, and the agent is told `shipped`

Date: 2026-09-28
Status: accepted (the product owner, 2026-09-28, after two rounds of
adversarial review). Not built yet.

## Context

The asynchronous mode sells goods that leave after the charge, and a missed
deadline or a refusal after it leaves a refund owed (ADR-0028). Its words
assume goods that reach the agent the moment they are handed over: `delivered`
ends the order, issues the receipt and stops every clock. A merchant who ships
a parcel knows only that a carrier took it. The deadline falls to a day the
agent never sees, nothing caps it, nothing tells the agent where to ask about
goods that have left, and the pilot pays in advance only for goods that survive
a second delivery (`apps/docs/index.md`), which a parcel does not.

## Decision

A card for shipped goods says `fulfillment: 'ship'`. Until the parcel ships,
money moves as in the asynchronous mode. The order records at purchase that it
is a parcel, so a republished card changes no order in flight, and the order
state machine gains no state. Such a card declares neither `ship_to`, which the
mode implies (ADR-0032), nor a `result`, which the mode fixes, and a card
carrying either, or `fulfill_deadline_seconds`, is refused. It must name
`ship_within_seconds`, the time to hand the parcel to a carrier counted from
the charge, at most 2 592 000 (thirty days), a limit written in the contract
and checked at publishing; the agent reads it on the card and as the absolute
`ship_by` on the order's status. It must have a price check answered by the
merchant's price handler, whose answer is the whole price with shipping; the
card's own price is the goods without shipping, and the contract's description
of that price says so. And its merchant must have given their shop's site
(ADR-0034).

`deliver` on a parcel records a shipment: a `carrier`, required, a short
plain-text string — a carrier's name, or the shop's own courier — and a
`tracking_number`, a required key holding the number, or `null` for a parcel
that has none, never an empty string; `tracking_url` and `estimated_delivery`
with `earliest` and `latest` are optional. All of it is the merchant's claim,
which we do not check; the gateway stamps the shipment's `shipped_at`. The same
shipment sent again is answered as already recorded; a different one is refused
with words saying that a shipment is recorded and cannot be changed. The
merchant deduplicates shipping on the order identifier, because a parcel cannot
be sent twice safely.

The order's internal state stays `delivered`, and it reads `shipped` to the
agent, to the merchant and on the receipt: the parcel is with the carrier and
the money with the merchant. That is the last word Agentify has about the
parcel, and the status's description says so, since every protocol using the
word goes on past it. The agent's status document carries the shipment in a
`shipment` field, while `delivered` stays `null`: nothing reached the agent. On
a parcel, `rejected` names what an unavailable price answer can mean: out of
stock, not shipped to that place, or an address missing what the merchant
needs. The discovery listing shows `ship_to` in its input schema and a shipment
in its example output, with Agentify's own office address and a carrier's
published test number. `ship` and `shipped` join the storefront's open
vocabularies (ADR-0006 §5), and the SDK's contract version moves once for the
whole mode.

What becomes of the parcel afterwards is between buyer and merchant. When a
merchant admits a parcel lost, ADR-0028's command records a refund on the
shipped order, which moves from `delivered` to `refunded` — the only way out of
`delivered`, and for parcels only — and the receipt reads the refund. A `ship`
card publishes on the test channel and is refused on the live one, with words,
until that command and ADR-0028's view of the payer run there, the cabinet
tells a merchant how to report a refund to the operator, and ADR-0011 records
whether whoever holds an order identifier may read its tracking.

## Consequences

The agent is told what we know and no more, on money paths already tested. A
lost parcel is invisible to us until the merchant says so. A shop's own
courier, with no tracking, can sell through this mode, and `shipped` then rests
on the merchant's word, as it would on a number nobody checks; a mistyped
number stays on the order. An order is one parcel of one card. The contract
version's move stops every worker on an older SDK at start-up, whether it sells
parcels or not. Duties, restricted goods, returns, an address changed after
payment or mistyped, and pickup points have no handling in this mode for now:
nothing refuses them, and the price an agent pays does not cover duties the
recipient may owe at the border, which the portal asks merchants to say in the
card's description.

Rejected: `delivered` with a caveat on the card (the status read alone would
claim arrival); an arrival state with its own deadline (merchants rarely know
arrival, and debts would fall on parcels at the door); a result each merchant
declares (no agent learns every shape); a second shipment accepted in silence
(a corrected number would vanish without a word); a required tracking number
(it shuts out local couriers and invites made-up numbers, and one we cannot
check proves no more than the word); reusing `fulfill_deadline_seconds` (one
name, two meanings); a ceiling in deployment configuration (unseen by the
offline check, and a lowered one strands published cards above it); reopening a
lost parcel into a refund owed (a stale delivery would close it); a "physical"
flag beside `fulfillment` (two fields for one fact; a parcel confirmed by hand
waits for ADR-0007's trigger).