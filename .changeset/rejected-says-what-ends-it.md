---
"@nuanu-ai/agentify-contracts": patch
---

The doc comments on the `rejected` status and on the agent's order document no
longer say that parameters which do not fit the card, or a payment that fails
its check, end an order as `rejected`. Unfit parameters are refused before any
order exists, and after a payment that fails its check the order stays open
until its price runs out and then reads `expired`; both are refused on the
call itself. No schema, published description, type or behaviour changes.
