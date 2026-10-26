---
"@nuanu-ai/agentify-contracts": patch
---

The description of the `list_catalog` route says the catalogue lists only
products that can be bought when it is read: a product is left out while its
card or its merchant is paused, while the merchant lacks what a sale needs,
while the merchant's own system has not polled for longer than Agentify allows,
and while the merchant has left too many paid orders without delivery or
closure. A merchant at the limit of purchases waiting for payment stays listed.
A product left out for its merchant's silence still answers a look at its
purchase address with the challenge. The description of `purchase_item` says
`seller_not_taking_orders` now refuses any purchase of a silent seller, a
synchronous one included, and a first payment at a price named before the
silence. Nothing a call sends or answers changes in shape.

A card a merchant reads back reads `selling: "open"` exactly when the public
catalogue lists it, so the descriptions of the merchant's own catalog and of
`MerchantCardSchema` name the merchant's silence and their unserved orders
among the reasons it reads paused.
