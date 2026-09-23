# 0028. Late goods settle a refund owed until a refund is recorded

Date: 2026-09-23
Status: accepted (Dmitry, 2026-09-23). Not built yet: the command that records
a refund, the operator's pause, and the merchant's view of the debt.

## Context

When an asynchronous order passes its delivery deadline with no goods, it
becomes `refund_due`. The buyer has paid, and the merchant owes the goods or
the money back from their own wallet (ADR-0019). The order state machine in
`packages/core` would end the debt as `refunded` on a `refund_settled` event,
but no command, route or screen produces that event. The merchant is not shown
the address to pay back. A late delivery is accepted and closes the debt. It
can come from the merchant's own worker without anyone deciding it, because a
`refund_due` order stays on the list of open orders a worker walks. No rule
says how long a debt may stand.

## Decision

Late goods settle the debt until a refund is recorded. Before that, a delivery
closes the order as `delivered`. A recorded refund makes it `refunded`, which
is final, and a later delivery gets a final error. This narrows what the
contract's `deliver_order` description and the portal's Orders page promise
today, "an error once the refund has gone out". A refund nobody reports cannot
be seen, so both texts change with the implementation.

The operator is whoever runs this deployment and its terminal commands. The
operator records a refund with a command, as ADR-0027 records a silent charge.
The command writes `refund_settled` and keeps the transaction beside the order,
in a field of its own. It is marked as a report, not a reading of the chain,
and it records who paid: the merchant, or Agentify where Agentify paid the buyer
back and then settles with the merchant outside the system.

On a `refund_due` order the merchant sees four things: the payer's address,
checksummed, wherever the payment layer named one; the amount and the network;
two ways out, deliver or report the refund to the operator; and a warning. A
refund that is paid but not reported does not stop a late delivery, including
one the merchant's own worker makes. Where no payer was named, only goods close
the debt, so the fourteen days below cannot be kept for that order. Until the
cabinet names a way to reach the operator, a merchant who signed themselves up
can report a refund only after the operator has contacted them.

The operator keeps the time, counted from the delivery deadline. After three
business days with neither goods nor a recorded refund, the operator contacts
the merchant and pauses their selling. By fourteen calendar days the buyer
holds the goods or the money. If the merchant has still done neither, the
operator settles it by hand, and at pilot prices Agentify may pay the buyer
back itself. These numbers are our own adaptation of practice. The sources,
each of which starts its clock at a different moment, are in
`docs/research/34-refund-due.md`. For an undelivered order this ends the
portal's line that Agentify does not stand between merchant and buyer.

The agent reads that `refund_due` is not an end: goods may still arrive at the
order's `status_url` until a refund is recorded. `refunded` is final, and
`refund_due` has no deadline of its own. Agents are told nothing about the three
or the fourteen days. If that ever changes, the time is given as an absolute
time the agent can read, never in business days, which an agent has no time
zone to count.

## Consequences

A buyer can still get the goods after the deadline, and a merchant has a way
out of the debt. A recorded refund cannot be undone. The cost is showing
the payer's address, a field on each order, two operator commands, the
operator's attention and, at worst, Agentify's money. The contract's words for
the agent and the merchant change with it, and so does the portal. This does not
protect against a refund that is paid but not reported and then followed by a
late delivery: the buyer ends up with both, which costs at most one purchase.
Practice lets the buyer choose between money and late goods; here the buyer
cannot. The timeline moves into the machine the first time an operator misses
it.

Rejected:
- Refusing late goods. With no refund payable or recordable, the buyer would be
  left with nothing.
- A grace window. It is a second deadline and a knob, and it does not stop the
  double outcome.
- The buyer choosing. It needs a route an agent writes through, where the only
  proof is the order identifier (ADR-0011).
- A merchant button to record a refund. It is another surface to learn and
  secure, while there are few merchants and one operator can record for them.
