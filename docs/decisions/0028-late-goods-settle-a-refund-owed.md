# 0028. The merchant closes fulfillment; Agentify does not confirm a refund

Date: 2026-09-23
Status: accepted. The product owner's word of 2026-10-19 decided the
merchant's closure action, that Agentify confirms no refund and staffs no
service, and that payment facts stay apart from fulfillment. What closure
refuses, the plain-text message, the notice of a payment completed after
closure with the second closure it allows, and Agentify's own reason on a paid
closed order were added on 2026-10-20, when the change was corrected on the
product owner's instruction to correct it and accept it.

## Context

A missed delivery deadline establishes that an order was not fulfilled in
time. It does not establish the remedy the merchant and buyer agree: a refund
can be partial, use another asset or network, or be replaced by an offset or
another agreement. Deciding whether that settles the parties' obligations
would make Agentify responsible for shop policy and adjudication.

## Decision

The merchant has one authenticated, idempotent action that stops future
fulfillment through Agentify, with an optional explanation to the buyer: the
SDK's `order.close()` and the dashboard's Orders, for either integration, both
calling `POST /v0/orders/:order_id/close`. A repeat keeps the first time and
words, except after a payment completed after closure (below). The public
claim is "fulfillment closed by merchant"; a claim of a refund or agreement
stays the merchant's, never "refund verified" or "parties settled". The merchant owns cancellation and refund policy, transfers and
fulfillment outside Agentify, and a missed deadline means unfulfilled, not a
mandatory whole-price refund. There is no refund proof protocol, transfer
reservation, refund RPC or staffed service, and Agentify signs no merchant
transfer (ADR-0019).

The original payment and order history remain. Closure is not nonpayment, does
not free an accepted authorization for reuse and causes no other charge. A
charge already sent may still complete under ADR-0027. Reads carry
`payment_status` apart from fulfillment, and an unknown payment keeps
`payment_unresolved` precedence with `merchant_closure` visible. A payment
that completes after closure reaches the merchant as `order.unfulfilled` with
the reason `paid_after_closure`, and the order is listed as open for them until
they close it again. On a paid closed order the agent reads Agentify's own
reason beside the merchant's words: paid, fulfillment closed by the merchant,
no refund confirmed. Agentify keeps its 0.1% commission, which neither the
split nor its warehouse returns (ADR-0037).

## Consequences and alternatives

An overdue paid order reads `unfulfilled`, a closed one `fulfillment_closed`
with the merchant's time and words in `merchant_closure`. The words are plain
text of bounded length, refused at the door otherwise, because a stranger's
agent reads them. Closure accepts an order whose fulfillment or payment is
still open, held goods and an unknown payment included. An order that ended
with nothing charged refuses it, since nothing is left to stop and closing
would erase the reason its agent acts on; a delivered or shipped order refuses
it with words saying so, and its receipt remains. Closing cancels no work
already running in the merchant's system or shop. Stored terminal orders with
no merchant action stay neutral: the migration invents no actor or time. No
net accounting or partial-refund schema is added, and address retention is
unchanged (ADR-0032).

Closure is built for parcels as for every order, so it no longer holds parcels
off the live channel; ADR-0033 names what still does. Evidence and remaining
work are in `docs/research/54-self-service.md`.

Rejected: verifying or coordinating the parties' agreement, an administrator
declaring it settled, a staffed reconciliation queue and a mandatory
whole-price return, each of which gives Agentify authority over shop policy or
claims an outcome it does not establish; and leaving a payment that completes
after closure to be found by reading, which hides money from the merchant who
received it.
