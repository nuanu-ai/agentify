---
"@nuanu-ai/agentify-contracts": minor
---

`bazaarDeclarationOf` declares as its output what a paid purchase really
answers: the order document, with the goods under `delivered` and the status
`delivered` on a card delivered in the answer, and an order `in_progress`
with `delivered: null` on every other, whose goods are collected at its
`status_url`. A parcel's example is its order paid and not yet with a
carrier, with `shipment: null` and `ship_by`. The declaration used to show
the bare goods, or a parcel's shipment, as if they were the answer. Every
value in the example still stands for its type. `CONTRACT_VERSION` does not
move: the payment challenge is the storefront's, which carries no version
(ADR-0006 §5).
