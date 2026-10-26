---
"@nuanu-ai/agentify-contracts": patch
---

The description of an erased delivery address, `ship_to: { erased_at }`, now
says what erasing reaches. It removes the address from Agentify's database.
Backups of the live channel taken before the erasure keep it until they
expire: most of it about sixty days later, and no upper bound is set yet for
all of it. Nothing a call sends or answers changes.
