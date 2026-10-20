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
order. A payment the payment layer refuses is answered the same whatever request
it came with. The
description no longer says that a different address is refused before the
payment is checked: it is compared once the payment has verified. No schema,
type or code list of the package changes, and `CONTRACT_VERSION` does not move.
