---
"@nuanu-ai/agentify-contracts": minor
---

`priceProblemsOf` refuses an amount above zero and below 0.01, a cent of USD
or of USDC, with a finding on `price.amount` that names the price and the
smallest price Agentify sells at. The payment network refuses payments below a
minimum it does not publish, and on the test channel a card at 0.000001 was
refused that way when a buyer paid, so such a card could be listed and never
bought. Publication and the answer to a price question now refuse prices they
used to accept, from 0.000001 up to 0.009999. The new export `SMALLEST_PRICE`
is that amount, `"0.01"`. The JSON Schema export states the rule on the card's
`price` and on a price answer's `price`, and the `answer_quote` route says so
in its description. No schema's shape changed, so cards, orders and receipts
already written are read back as they were.
