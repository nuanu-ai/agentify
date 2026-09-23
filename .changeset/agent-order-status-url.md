---
"@nuanu-ai/agentify-contracts": minor
---

The order document an agent reads now carries `status_url`, a required field
holding the absolute address of the order's status route. An agent that buys a
product whose goods come later receives an order and no goods, and until now no
answer said where to come back for them. Every answer that carries the document
names the address, the purchase's own answer included. A reader holding the
previous schema refuses a document with the new field, and the new schema
refuses one without it, which is why this is a minor release rather than a
patch.
