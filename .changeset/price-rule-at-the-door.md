---
"@nuanu-ai/agentify-contracts": minor
---

`priceProblemsOf`, `PAYABLE_CURRENCIES` and `PAYABLE_DECIMALS` are the rule a
price a merchant sets is held to: an amount above zero, written in dollars with
at least two and at most six digits after the dot (the places of USDC, which a
buyer pays in), in USD or USDC. The gateway applies it to a card's price
at publication and to a price check's answer, and refuses a price that breaks
it with a finding on `price.amount` or `price.currency` naming what it found.
A price of zero is refused by design: a free item is offered from the
merchant's own site, without a payment. The JSON Schema export states the
rule on the card's `price` and on a price answer's `price`, and the
`answer_quote` route says how an answer that breaks it is refused. No schema's
shape changed, so cards, orders and receipts already written are read back as
they were.
