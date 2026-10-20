---
"@nuanu-ai/agentify-contracts": minor
"@nuanu-ai/agentify": minor
---

A merchant can now close fulfillment of an order through Agentify, and the
words for a paid order without delivery no longer speak of refunds. This
release removes and renames exported names and wire words without aliases, so
code written against the previous release needs the changes below before it
compiles or reads the new gateway correctly.

Closing an order is `order.close({ message })` on any bound order in the SDK,
and `POST /v0/orders/:order_id/close` on the wire. It stops fulfillment
through Agentify for that order and answers `{ ok: true }`, also on a retry,
which keeps the first closure's time and optional message except after a late
payment, described below. The message is the merchant's statement to the
buyer, read by the buyer's agent as the merchant's own words. It is plain text
of at most 2000 characters, an emoji counting as one: markup, character
references, control characters other than the line feed, bidirectional
control characters and half of a character cut in two are refused with 400.
Agentify confirms no refund or agreement. Closing is refused, with the order
left as it is, as `fulfillment_complete` on an order already delivered or
shipped and as `nothing_to_close` on one that ended without a charge. It
cancels no payment: a payment Agentify had already asked the facilitator to
execute may still go through after the closure. If it does, the merchant
receives `order.unfulfilled` with the new reason `paid_after_closure`, and the
order is on `orders.list({ open: true })` until the merchant closes it again,
which records that closure's own time and message.

The words that change, old to new:

- order status `refund_due` is now `unfulfilled`, and `refunded` is now
  `fulfillment_closed`; the receipt outcome words change the same way;
- the event `order.refund_due` is now `order.unfulfilled`, and
  `ORDER_EVENT_TYPES.REFUND_DUE` is now `ORDER_EVENT_TYPES.UNFULFILLED`;
- `RefundDueReasonSchema` and the type `RefundDueReason` are now
  `UnfulfilledReasonSchema` and `UnfulfilledReason`, and the JSON Schema
  export `refund_due_reason` is now `unfulfilled_reason`; its words are
  `refused`, `deadline_passed`, `merchant_left` and the new
  `paid_after_closure`;
- the order call result `debt_closed_by_delivery` is now `delivered_late`;
- the error code `refund_already_settled` is now `fulfillment_closed`, and
  `fulfillment_complete` and `nothing_to_close` are new.

What is added: `payment_status` (`not_paid`, `paid` or `unresolved`) is a
required field of `OrderWithStatus` and of the agent's order document, and
`merchant_closure` an optional one, with `PaymentStatusSchema`,
`MerchantClosureSchema`, `OrderCloseRequestSchema` and
`OrderCloseResponseSchema` and their types. `OrderCalls` gains a required
`close`, so a test double of it must add one. On the agent's order document,
`payment_status` is an open word like `status`; every `unfulfilled` order
carries a `reason` saying why nothing was delivered, and a paid
`fulfillment_closed` order carries the reason `merchant_closed` in Agentify's
words beside the merchant's.

A worker on the previous SDK cannot read the new gateway: `orders.get` and
`orders.list` fail on the new required field, a poll carrying
`order.unfulfilled` fails, and a late delivery's `delivered_late` reads as an
answer it cannot understand. Move workers to this release together with the
gateway. `CONTRACT_VERSION` stays `"2"`, as ADR-0006 allows until the first
merchant we do not control.
