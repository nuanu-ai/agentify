---
"@nuanu-ai/agentify-contracts": patch
---

The descriptions of `register_merchant`, `issue_cabinet_key` and
`forget_cabinet_key` say what is true of them: none is on the public origin.
Only the cabinet makes these calls, from inside the stack, and from outside
their paths answer as ones the site does not have. No schema, route or status
changes, and no merchant's own code ever made these calls.
