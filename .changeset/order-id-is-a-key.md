---
"@nuanu-ai/agentify-contracts": patch
---

The agent's order document says that `order_id`, and the `status_url` built
from it, are the only key to the order and its goods: anyone who holds either
can read them, so they are not to be shared. The status route's answers tell
caches to keep nothing, and its description names the payment facilitator
that checks and executes the payment among those the identifier is handed to. No schema, type or behaviour of the package changes,
and `CONTRACT_VERSION` does not move.
