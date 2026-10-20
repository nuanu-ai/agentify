---
"@nuanu-ai/agentify-contracts": patch
---

The agent's order status describes a `reason` on every `delivered_unpaid`
order. It is `payment_not_settled`, already one of the order ending reasons,
and its sentence says that the merchant made the goods, that the charge did not
go through so nothing was taken, that Agentify holds the goods, and that a
payment for this same purchase from the wallet that signed it releases them. The
descriptions of the status document, of its `reason` field, of the
`delivered_unpaid` status and of the `payment_not_settled` reason say so. No
schema, type or list of words changes, and `CONTRACT_VERSION` does not move.
