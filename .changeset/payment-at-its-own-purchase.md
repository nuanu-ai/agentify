---
"@nuanu-ai/agentify-contracts": patch
---

The description of the purchase request says that a payment is answered only
at the purchase it was made for. Sent with the payment, the product's address
and the params must be the ones that were priced, and `ship_to` the same
address or left out. A payment the payment layer accepts that comes with
another address is refused as `ship_to_changed`, and one that comes at another
product's address or with other params as `payment_not_taken`; neither refusal
claims or charges anything for the request it answers, and its words name no
order. A payment that is not verified is refused before either comparison, in
words that are the same whether or not its order was paid and whoever refused it:
that this payment charged nothing, what to do next, the reason it was refused,
and that a fresh payment for the same payment request from the wallet that
signed it returns a purchase already paid for without a second charge. The
description no longer says that a different address is refused before the
payment is checked: it is compared once the payment has verified. No schema,
type or code list of the package changes, and `CONTRACT_VERSION` does not move.
