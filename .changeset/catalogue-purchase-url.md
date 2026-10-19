---
"@nuanu-ai/agentify-contracts": minor
---

Every product in the catalogue an agent reads carries `purchase_url`: the
whole address it is bought at, scheme and host included, built from the
gateway's configured address and the same one its payment challenge names as
the resource. Until now the catalogue gave an agent a product and a price but
no address to buy it at. `PublicCardSchema` requires the field and refuses a
path or another scheme, and `publicCardOf` takes it beside the identifier.
`CONTRACT_VERSION` does not move: the storefront's documents carry no version
and take fields added later (ADR-0006 §5), and no worker of the merchant's SDK
reads the catalogue. A reader on this version passes over an item without the
field, so against a gateway released before it, `cardsOf` returns an empty
catalogue until that gateway is released too.
