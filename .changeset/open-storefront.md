---
"@nuanu-ai/agentify-contracts": minor
---

The documents an agent reads take what is added to them later (ADR-0006 §5).
The catalog page, the card in it and an order's status accept fields this
version does not name, and a card's `fulfillment` and an order's `status` are
words whose known values are listed beside them, so a word added later is read
rather than refused. The catalog page holds its items as they arrive, and the
new `cardsOf(page)` reads each one on its own as a card, passing over one that
does not read, so a single card of a later mode leaves the rest of the page for
sale. In TypeScript, `CatalogPage["items"]` is `unknown[]`, and a card's
`fulfillment` and an order status's `status` are strings. The merchant's own
documents stay closed.
