---
"@nuanu-ai/agentify-contracts": patch
---

The description of the purchase request says that a payer whose answer was
lost and who signs the kept payment request again gets an order already paid
back from a check made by the gateway itself, not by the payment layer: that
payment is never charged, so the wallet need not hold the price again. It has
to be a fresh signature that is still valid, since the payment that paid the
order can be read from the chain and is refused, and a fresh signature from
any other wallet is refused as `not_this_purchase`. A payment that is not
verified is answered in words that name no order and do not say whether the
order was paid, with the reason it was refused in the words of whoever refused
it, the gateway or the payment layer; the description no longer says those
words are the same either way.
