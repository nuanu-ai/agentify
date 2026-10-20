# 0028. The merchant closes fulfillment; Agentify does not confirm a refund

Date: 2026-09-23
Status: accepted (the product owner, 2026-10-19).

## Context

A missed delivery deadline establishes that an order was not fulfilled in time. It
does not establish the remedy the merchant and buyer agree. A refund can be
partial, use another asset or network, or be replaced by an offset or another
agreement. Deciding whether that settles the parties' obligations would make
Agentify responsible for shop policy and adjudication.

## Decision

The merchant has one authenticated, idempotent action to stop future
fulfillment through Agentify, optionally explaining the action to the buyer.
The SDK offers `order.close()` with an optional `message`; Orders in the dashboard
offers the same action for either integration. It calls the merchant-authenticated
`POST /v0/orders/:order_id/close`. Repetition preserves the first time and message.
Agentify records the merchant's action and stops its own future fulfillment.
The public claim is "fulfillment closed by merchant". An assertion of a refund
or agreement stays attributed to the merchant; it is not "refund verified" or
"parties settled". Agentify neither confirms a refund nor judges the agreement.

The merchant owns cancellation and refund policy, transfers and fulfillment
outside Agentify. A missed deadline means unfulfilled by the deadline, not a
mandatory whole-price refund. Partial refunds, another currency or network,
and offsets require neither Agentify exceptions nor database repair. There is
no refund proof protocol, transfer reservation, refund RPC or staffed service.
Agentify signs no merchant transfer and keeps no merchant key (ADR-0019).

The original payment and order history remain. Closure is not nonpayment,
does not release an accepted payment authorization for reuse and does not
cause another charge. Original payment verification and recovery stay under
ADR-0027: a payment already accepted for execution may still finish after
closure. Reads carry `payment_status` independently of fulfillment. Unknown
payment keeps `payment_unresolved` precedence, with `merchant_closure` visible.
Agentify retains its 0.1% commission; neither the split nor its
warehouse returns it (ADR-0037). This decision adds no net accounting or
partial-refund schema and changes no address-retention rule (ADR-0032).

## Consequences and alternatives

An overdue paid order reads `unfulfilled`. Merchant closure reads
`fulfillment_closed`, with the merchant's time and optional words in
`merchant_closure`. It accepts any order before delivery or shipment is
recorded, including one with held goods or an unknown payment.
A delivered or shipped order refuses closure; its facts and
receipt remain. Closing cannot cancel work already running in the merchant's
integration or shop. Existing stored terminal closures without an authenticated
merchant action remain neutral; no actor or time is invented by migration.

Parcels remain refused on live until their closure flow and public contract
are implemented, reviewed and tested, and their other readiness gates hold
(ADR-0033). No goods-or-money guarantee or Agentify-funded refund is promised.
Evidence and remaining work are in `docs/research/54-self-service.md`.

Rejected: verifying or coordinating the parties' refund agreement, an
administrator declaring it settled, a staffed reconciliation queue and a
mandatory whole-price return. Each gives Agentify authority over shop policy
or claims an outcome it does not establish.
