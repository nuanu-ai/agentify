---
"@nuanu-ai/agentify-contracts": minor
"@nuanu-ai/agentify": minor
---

The confirmation mode is gone from the contract. `FulfillmentSchema` is
`sync`, `async` or `ship`, and a card naming `confirm` is refused with the
ordinary list of modes; the card and the agent's public card have no
`confirm_deadline_seconds`; the order status `declined` and the event
`order.unpaid_after_confirmation` (`ORDER_EVENT_TYPES.UNPAID_AFTER_CONFIRMATION`)
are removed. No card could be published in that mode, so the gateway sent none
of these values, and a reader built on the previous version reads everything
it sends today. The SDK re-exports the narrower `Card`, `CardInput`,
`Fulfillment`, `OrderStatus` and `OrderEvent` types and `ORDER_EVENT_TYPES`
without that member.
