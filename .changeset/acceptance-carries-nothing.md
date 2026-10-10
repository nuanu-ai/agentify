---
"@nuanu-ai/agentify-contracts": minor
"@nuanu-ai/agentify": minor
---

An acceptance carries nothing. `eta_seconds` is gone from `AcceptanceSchema`,
from `order.accepted()` and `accept()` in the SDK, and from the `Acceptance`
type the SDK re-exported, because nothing kept the number and no agent saw it.
A body that still names it is refused with words saying it was removed and to
answer `accepted()` with nothing in it. A worker on an earlier SDK that sent it
has to move to this one.
