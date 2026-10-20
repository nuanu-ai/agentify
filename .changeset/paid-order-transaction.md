---
"@nuanu-ai/agentify-contracts": minor
---

The agent's order status (`AgentOrderStatusSchema`) gains an optional
`transaction`: the buyer's payment as reported by the facilitator or verified
from chain evidence, as the receipt's `transaction` names it, on the chain of
the deployment. It is present once `payment_status` is `paid` and a transaction
was recorded, whether or not the goods have been delivered, and absent before
that and on a payment that is `not_paid` or `unresolved`. The purchase route's
description says that every answer about an order whose charge has gone
through carries the standard x402 payment response header, whatever the card's
mode, and the example answer a card's discovery declaration carries names
`transaction` beside `payment_status`. The agent's status document takes fields
added later, so `CONTRACT_VERSION` does not move.
