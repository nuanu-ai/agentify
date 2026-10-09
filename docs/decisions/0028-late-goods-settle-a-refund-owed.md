# 0028. Late goods settle a refund owed until a refund is recorded

Date: 2026-09-23
Status: accepted (the product owner, 2026-09-23 and 2026-09-28). The order
state machine follows the rule; the refund command, the operator's pause, the
merchant's view and the published words for a recorded refund are not built.

## Context

When an asynchronous order passes its delivery deadline with no goods, it
becomes `refund_due`: the buyer has paid, and the merchant owes the goods or
the money back from their own wallet (ADR-0019), a refund paid outside Agentify
that nothing in the system sees. A late delivery can still arrive, even from
the merchant's own worker with nobody deciding it, because a `refund_due` order
stays on the list of open orders a worker walks.

## Decision

Late goods settle the debt until a refund is recorded. Before that, a delivery
closes the order as `delivered`, and the agent reads `refund_due` as not an
end: goods may still arrive at the order's `status_url`, and `refund_due` has
no deadline of its own. A recorded refund makes the order `refunded`, which is
final, and a later delivery gets a final error. A refund nobody reports cannot
be seen, so the contract and the portal promise that error once a refund is
recorded, not once it has gone out.

The operator, whoever runs this deployment, records a refund with a terminal
command, as ADR-0027 records a silent charge. The transaction is kept beside
the order in a field of its own, marked as a report rather than a reading of
the chain, with who paid: the merchant, or Agentify where it paid the buyer
back and settles with the merchant outside the system. The same command records
a refund on a shipped order (ADR-0033) whose parcel the merchant admits lost.
That order is not reopened into a refund owed, because a stale delivery from
the merchant's worker would close the debt with nothing sent, and a replacement
parcel is the merchant's to send, unrecorded here.

The merchant sees, on a `refund_due` order and on a shipped one, the payer's
checksummed wallet address where the payment layer named one, with the amount
and the network. On a `refund_due` order they also see the two ways out,
deliver or report the refund to the operator, the timeline below, and a warning
that a refund paid but not reported does not stop a late delivery.

The operator keeps the time from the delivery deadline, by numbers adapted from
practice (`docs/research/34-refund-due.md`). After three business days with
neither goods nor a recorded refund, they contact the merchant and pause their
selling until the debt is settled. By fourteen calendar days the buyer holds
the goods or the money, settled by the operator by hand if need be, and at
pilot prices Agentify may pay the buyer back itself. Where no payer was named,
only goods close the debt and the fourteen days cannot be kept. Agents are told
nothing of these days; if ever they are, it is as an absolute instant, never in
business days, which an agent has no time zone to count.

## Consequences

A buyer can still get the goods after the deadline, a merchant has a way out of
the debt, and for an undelivered order Agentify stands between merchant and
buyer. A recorded refund cannot be undone. The cost is showing the payer's
address, a field on each order, two operator commands, the operator's attention
and, at worst, Agentify's money. A refund paid but not reported and followed by
a late delivery leaves the buyer with both, at most one purchase. The timeline
moves into the machine the first time an operator misses it.

Rejected: refusing late goods (with no refund payable or recordable, the buyer
is left with nothing); a grace window (a second deadline and a knob, which does
not stop the double outcome); the buyer choosing between money and late goods,
as practice allows (it needs a route an agent writes through, where the only
proof is the order identifier, ADR-0011); a merchant button to record a refund
(one more surface to secure, while one operator can record for few merchants).
