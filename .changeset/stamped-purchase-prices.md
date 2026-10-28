---
"@nuanu-ai/agentify-contracts": minor
"@nuanu-ai/agentify": minor
---

This release speaks contract version 6. A worker on an older SDK reports the
problem `contract_version_mismatch` at its first poll after the gateway is
released and stops; your sales through it resume once you upgrade to this
release and start the worker again.

A price question you answer no longer opens an order. Agentify puts your price
in the payment request under its own stamp and writes the order only when the
buyer's payment arrives and is verified, so answering a price question reserves
no stock and your handler should not set any aside for it. An order reaches
your handler only once a payment has been presented for it. The ending reasons
`unavailable`, `price_check_unanswered` and `price_expired` and the refusal
codes `order_not_priced_yet` and `order_closed_before_it_was_priced` are gone,
because no order can reach them.

Your price answer may carry an optional `quote_reference` of up to 512
printable characters, which Agentify stamps with the price and returns
unchanged on the order. The buyer can read it in the payment request, so put
no secrets and no personal data in it.

When a discovery catalogue replays the example purchase your card lists,
Agentify answers it as a look at the listing and does not ask your price
handler.

The contracts package exports `listedPurchaseOf`, the example purchase a
card's listing declares.
