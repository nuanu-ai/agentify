---
"@nuanu-ai/agentify-contracts": minor
"@nuanu-ai/agentify": minor
---

A merchant's selling state is `open` or `paused`; `departed` is gone from
`SellingStateSchema`, because nothing could set a merchant to it. With it go
the order status `cancelled`, the reason `merchant_left` on `order.unfulfilled`
and on an unfulfilled order's status, and the error code `merchant_departed`.
The descriptions of the pause and resume routes no longer speak of a merchant
who has left. The gateway sent none of these values, so a reader built on the
previous version reads everything it sends today. The SDK re-exports the
narrower `OrderStatus` and `OrderEvent` types.
