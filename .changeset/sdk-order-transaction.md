---
"@nuanu-ai/agentify": minor
---

`orders.get` and `orders.list` return `transaction` on a paid order: the
transaction that paid it, present once the payment went through and a
transaction was recorded, whether or not you have delivered. It is how you find
the payment of an order you could not deliver, which has no receipt.

The package speaks contract version `4`. A worker on an earlier release stops
at its first poll answer from a gateway that speaks `4`, with a
`contract_version_mismatch` problem naming both versions, once the work already
in its handlers has finished. Code on an earlier release that reads orders
without polling, such as a reconciliation script or a loop over open orders,
fails differently: `orders.get` throws on every paid order because of the
unknown `transaction`, and `orders.list` leaves every paid order out with one
`unread` problem, so the orders that need you are the ones it does not return.
Upgrade before reading orders.
