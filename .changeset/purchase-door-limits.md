---
"@nuanu-ai/agentify-contracts": minor
---

Two codes join `ERROR_CODES`, both refusals of a purchase before anything is
charged and both with `retryable` true: `seller_busy`, when the seller already
has as many purchases priced and waiting for payment as the gateway holds open
for one seller at once, and `seller_not_taking_orders`, when the purchase would
charge before the goods are made and the seller's own process is out of touch
with the gateway. A client that switches over `ERROR_CODES` and keeps a default
arm reads either as an ordinary refusal with a sentence to show.
