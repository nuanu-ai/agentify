# 0032. A shipped order ends at the carrier, and the agent is told `shipped`

Date: 2026-09-28
Status: accepted (Dmitry, 2026-09-28: «Полностью согласен»). Not built yet.

## Context

The asynchronous mode carries goods that leave later: the money moves at the
purchase, the merchant takes the order on and delivers by a separate call
before a deadline, and a missed deadline or a refusal after the charge leaves
a refund owed (ADR-0028). Its words assume goods that reach the agent the
moment they are handed over. `delivered` says the goods are the agent's; it
ends the order, issues the receipt and stops every clock, and a second
delivery is answered as a success and kept nowhere. A merchant who ships a
parcel knows only that a carrier took it. The delivery deadline falls to a day
the agent is never shown and has no ceiling, and nothing tells the agent where
to ask about goods that have left. The pilot pays in advance only for goods
that survive being delivered twice until a refund can be recorded
(`apps/docs/index.md`), and a parcel does not.

## Decision

A card for goods that are shipped says `fulfillment: 'ship'`. For money and
time it is the asynchronous mode — charged at the purchase, taken on, closed by
a separate call, a refund owed on a missed deadline or a refusal after the
charge — and the machine gains no state. What differs is what is asked, what
is promised and what is said.

The agent supplies `ship_to` (ADR-0031). The card has a price check, because
the destination decides both the cost of shipping and whether the merchant
ships there at all. The card must name `fulfill_deadline_seconds`, which here
is the time to ship: counted from the charge, shown to the agent before it
buys, and held under a ceiling the gateway's configuration sets and the portal
publishes. The merchant declares no result; what they record is a shipment of
the contract's shape, named as the agent-commerce protocols name it: the
`carrier` and the `tracking_number`, which are required, a `tracking_url`, an
`estimated_delivery` with `earliest` and `latest`, and a `support` of `email`,
`phone` or `help_center_url` for where the buyer asks
(`docs/research/37-physical-goods.md`).

A recorded shipment reads `shipped`, to the agent and to the merchant alike:
the parcel is with the carrier, the money with the merchant, and Agentify
learns nothing further — which the status's description says, because in
every protocol that uses the word it is not the last one. The machine's
`delivered` state is unchanged; only the word read outside differs. An older
SDK cannot read a new status word, so the contract version moves when this is
built (ADR-0006).

What becomes of the parcel afterwards is between the buyer and the merchant.
When the operator's command of ADR-0028 exists, it also turns a shipped order
whose parcel the merchant admits lost into a refund owed, and ADR-0028 applies
from there: a second parcel settles the debt, a recorded refund ends it. Until
that command exists, a `ship` card publishes on the test channel and is refused
on the live one with words naming the reason.

## Consequences

The agent is told what we know and no more, on a machine whose money paths are
already tested, and the path can be shown before a merchant asks for it. A
lost parcel is invisible to us until somebody tells the operator, and nobody
can record one until the command exists, which is why live sale waits. A
merchant who ships without tracking cannot sell through this mode. The
tracking number is personal data by association and stays on the order as its
goods, readable by whoever holds the order identifier; ADR-0011's revisit
weighs it. An order is one parcel of one card, with no quantity and no split
shipment. A destination refused reaches the agent as a bare `rejected`, like
"out of stock", because a price answer carries no reason. A parcel cannot be
shipped twice safely, so keying on the order identifier stops being advice.

Rejected: `delivered` with a caveat on the card (an agent reading the status is
told a parcel in transit arrived); a second state with an arrival deadline
(merchants rarely know arrival, the deadline would raise debts on parcels at
the door, and the agent would wait weeks for an ending); a result each merchant
declares (no agent could learn every shape); a second `deliver` to update the
tracking (the call keeps the first delivery in every mode); tracking left
optional (the merchant's word alone would stop the clock, and a buyer's claim
has nothing to stand on); a "physical" flag beside `fulfillment` (two fields
saying one thing; a parcel confirmed by hand has no merchant yet, and
ADR-0007's trigger decides when it does).
