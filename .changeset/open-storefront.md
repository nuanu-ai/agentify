---
"@nuanu-ai/agentify-contracts": minor
---

The documents an agent reads take what is added to them later (ADR-0006 §5).
The catalog page, the card in it and an order's status accept fields this
version does not name, both beside their fields and inside their parts — the
seller, a price, a declared field, a merchant's refusal — and a card's
`fulfillment` and an order's `status` are words whose known values are listed
beside them, so a word added later is read rather than refused. Such a word is
an `OpenWordSchema`: lower-case letters, digits and underscores, starting with
a letter and at most sixty-four characters long. A declared field's `type`
stays a closed list. The exported `public_card` is now one object rather than a
branch per mode, so the rule that only some modes name a deadline is stated in
its description rather than in its structure. The catalog page holds its items
as they arrive, and the new `cardsOf(page)` reads each one on its own, passing
over an item that does not read as a card and a card of a mode this version
does not name, so the rest of the page stays for sale. In TypeScript,
`CatalogPage["items"]` is `unknown[]`, a card's `fulfillment` and an order
status's `status` are strings, and `publicCardOf` returns a `ProjectedCard`:
the card's own fields without the open schema's index signature, and a mode
this version names. The merchant's own documents stay closed.
