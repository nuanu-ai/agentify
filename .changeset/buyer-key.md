---
"@nuanu-ai/agentify-contracts": minor
"@nuanu-ai/agentify": patch
---

An order's status route is opened by a buyer's key rather than by the order's
identifier. `API_ROUTES.get_order_status` is `/x402/orders/:buyer_key/status`,
and its door in `AUTH_MODES` is `buyer_key`, which replaces `order_id`. The key
is created with the order and reaches only the agent that bought, inside the
`status_url` of the purchase's answer and of the status document; the route
answers an order identifier as a key that names no order. The order's
identifier is an ordinary reference that opens nothing, so the status
document's description now says `status_url` is the key not to be shared and
`order_id` is not a secret, and the purchase route's description says the
payment requirements name the order by `extra.order_id`, which replaces
`extra.payment_ref`. The merchant's order document is unchanged, and
`CONTRACT_VERSION` does not move. The SDK's README says that `order.id` is safe
to log and to pass to a supplier.
