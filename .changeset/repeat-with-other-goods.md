---
"@nuanu-ai/agentify": minor
"@nuanu-ai/agentify-contracts": minor
---

A delivery of an order already delivered that carries other goods than the
ones the buyer has is answered with the new word
`already_delivered_other_goods`, still `ok: true`, and the buyer keeps the first
goods. The SDK reports a `repeat_with_other_goods` problem naming the order,
without either goods, whether the delivery came from a handler or from
`deliver`. An SDK release that does not know the word reads it as `unknown`.
