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
in its handlers has finished. Upgrade the package with the gateway.
