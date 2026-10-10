---
"@nuanu-ai/agentify-contracts": minor
"@nuanu-ai/agentify": minor
---

A card's `price_check` is `"handler"` and nothing else. The `{ url }` form,
a price hook at an address of the merchant's own, is gone from
`PriceCheckSchema`, from the `Card` type and from the JSON Schema export,
because the gateway never calls such an address: a card that named one was
accepted and then priced as though the merchant had not answered, so a
synchronous product quietly sold at its listed price and an asynchronous one
quietly refused every sale. Publishing such a card, and `checkCard` on it,
now refuse it with a finding at `price_check` that says the price is asked
of the merchant's own price handler. The price hook stays designed and
uncalled; `CONTRACT_VERSION` does not move, because nothing a worker reads
changes.
