# 0032. A shipped order ends at the carrier, and the agent is told `shipped`

Date: 2026-09-28
Status: accepted (Dmitry, 2026-09-28: «Полностью согласен»). Not built yet.

## Context

The asynchronous mode already carries goods that leave later: the money moves
at the purchase, the merchant takes the order on and delivers by a separate
call before a deadline, and a missed deadline or a refusal after the charge
leaves a refund owed (ADR-0028). Its words assume goods that reach the agent
the moment they are handed over. `delivered` says the goods are the agent's and
the money the merchant's; it ends the order, issues the receipt and stops every
clock, and a second delivery is answered as a success and kept nowhere. A
merchant who ships a parcel knows only that a carrier took it, and reporting
that as `delivered` would tell somebody else's agent that a parcel still in a
van has arrived. The delivery deadline falls to a day the agent is never shown
and has no ceiling, and nothing tells the agent where to ask about goods once
they have left. The pilot pays in advance only for goods that survive being
delivered twice, until a refund can be recorded (`apps/docs/index.md`), and a
parcel does not survive that.

## Decision

A card for goods that are shipped says `fulfillment: 'ship'`. For money and
time it is the asynchronous mode: the buyer is charged at the purchase, the
merchant takes the order on and records the shipment by a separate call, and a
missed deadline or a refusal after the charge is a refund owed. The machine's
switches are the asynchronous ones and it gains no state. What differs is what
is asked, what is promised and what is said.

The agent supplies `ship_to` (ADR-0031). The card has a price check, because
the destination decides both the cost of shipping and whether the merchant
ships there at all, and a destination refused after the charge would be a
debt. The card must name `fulfill_deadline_seconds`, which in this mode is the
time to ship, counted from the charge and shown to the agent before it buys;
it has a ceiling, a number of the gateway's configuration that the portal
publishes like the others. The merchant declares no result: what they record
is a shipment of the contract's shape — the carrier, the tracking number and
the tracking address where they exist, and where the buyer asks about the
delivery — with fields named after `docs/research/37-physical-goods.md`.

A recorded shipment reads `shipped`, to the agent and to the merchant alike:
handed to the carrier, the money with the merchant, nothing further known to
Agentify. The machine's `delivered` state is unchanged — the merchant owes us
nothing more and the receipt is issued — and only the word read outside
differs. An older SDK cannot read a new status word, so the contract version
moves when this is built (ADR-0006).

What becomes of the parcel after that is between the buyer and the merchant,
and `shipped` says so. When the operator's command of ADR-0028 is built, it
also turns a shipped order whose parcel the merchant admits lost into a refund
owed, and from there ADR-0028 applies unchanged: a second parcel settles the
debt, a recorded refund ends it. Until that command exists a `ship` card
publishes on the test channel and is refused on the live one with words naming
the reason, so the pilot's rule stays whole and the path can be shown before a
merchant asks for it.

## Consequences

The agent is told what we know and no more, and a parcel is sold on a machine
whose money paths are already tested. Agentify learns nothing after shipment:
a lost parcel is invisible until somebody tells the operator, and until the
command exists nobody can record it, which is why live sale waits. A tracking
number is personal data by association; it stays on the order as its goods,
readable by whoever holds the order identifier (ADR-0011), and that decision's
revisit before the first outside buyer weighs it. An order is one parcel of one
card: no quantity, no split shipment. A destination the merchant will not serve
reaches the agent as a bare `rejected`, the same word as "out of stock",
because a price answer carries no reason. A parcel is not safe to ship twice,
so keying on the order identifier stops being advice in this mode.

Rejected:
- `delivered` with a caveat on the card. An agent that reads the status and not
  the card is told that a parcel in transit arrived.
- A second state with an arrival deadline. Merchants rarely know that a parcel
  arrived; the deadline would raise debts on parcels already at the door, and
  the agent would wait weeks for an ending.
- A result each merchant declares for parcels. Every shop would invent a shape,
  and an agent could learn none of them.
- A second `deliver` to update the tracking. The call keeps the first delivery
  in every mode, and that promise is not unmade for one.
- A separate "physical" flag beside `fulfillment`. Two fields would say one
  thing, and a parcel confirmed by hand first has no merchant yet; ADR-0007's
  trigger decides when it does.
