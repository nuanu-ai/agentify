---
"@nuanu-ai/agentify-contracts": minor
---

`priceProblemsOf` and `PAYABLE_CURRENCIES` are the rule a price a merchant
sets is held to: an amount above zero, written in dollars with at least two
digits after the dot, in USD or USDC. The gateway applies it to a card's price
at publication and to a price check's answer, and refuses a price that breaks
it with a finding on `price.amount` or `price.currency` naming what it found.
A price of zero is refused by design: a free item is offered from the
merchant's own site, without a payment. No schema changed, so cards, orders
and receipts already written are read back as they were.
