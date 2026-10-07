---
"@nuanu-ai/agentify-contracts": minor
---

An agent reads who sells. Every card in the catalog and the status of every
order carry `seller`, the name the merchant sells under and the https origin of
their shop's own site, each `null` where none was given and neither checked by
Agentify (ADR-0034). The seller-name document carries `seller_site` beside
`seller_name`, and a request to the seller-name route may send the name, the
site or both; a request that sends the name alone is taken as before, and its
answer gains `seller_site`. A reader validating the card, the order status or
the seller-name document with an earlier version of this package refuses the
new fields: update it before reading a gateway that sends them.
`SellerSchema` and `SellerSiteSchema` are exported. A seller name sent to the
route is now held to the plain-text rule the card's words are: HTML markup and
character references such as `&amp;` are refused.
