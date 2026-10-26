---
"@nuanu-ai/agentify-contracts": minor
---

`seller_not_fulfilling` joins `ERROR_CODES`. A purchase is refused with it, with
HTTP 409 and `retryable` false, while the seller has ten or more paid orders
they took on and left without delivery or closure. The refusal covers every
purchase of that seller, synchronous ones included, and comes before the price
is asked, so nothing is charged. A payment at a price named before the seller
reached ten is refused with it too, before the payment is checked, and so is a
look at the product, which then carries no payment challenge. A payment that
releases goods already made goes through. The refusal ends by itself once the
seller delivers or closes enough of those orders to leave fewer than ten. A client that switches over `ERROR_CODES` and keeps a default arm reads it
as an ordinary refusal with a sentence to show.

The description of the purchase route lists it beside `seller_busy` and
`seller_not_taking_orders`.
