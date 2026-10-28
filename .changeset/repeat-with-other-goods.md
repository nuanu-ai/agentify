---
"@nuanu-ai/agentify": minor
"@nuanu-ai/agentify-contracts": minor
---

If you deliver an order again with other goods than the ones the buyer already
has, the answer is still `ok: true`, with the new word
`already_delivered_other_goods`, and the buyer keeps the goods you delivered
first. The SDK reports a `repeat_with_other_goods` problem naming the order,
without either set of goods, whether the delivery came from a handler or from
`deliver`. An older SDK that does not know the word reads it as `unknown`.
