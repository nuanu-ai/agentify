---
"@nuanu-ai/agentify-contracts": minor
---

Two codes join `ERROR_CODES`, both refusals of a purchase before anything is
charged and both with `retryable` true: `seller_busy`, with HTTP 429 and a
`Retry-After`, while twenty of the seller's purchases already wait for payment,
and `seller_not_taking_orders`, for a purchase that charges before its goods
while the seller's own process has not polled for ten minutes. A client that
switches over `ERROR_CODES` and keeps a default arm reads either as an ordinary
refusal with a sentence to show.

The descriptions of the purchase route, the order status route and the
merchant's list of orders say so, and say that an order which ended rejected or
expired with nothing charged or held is deleted thirty days after it was last
written, after which its identifier is answered as one that names no order and
it leaves the merchant's list.
