---
"@nuanu-ai/agentify-contracts": patch
---

Identify generated JSON Schema documents with `urn:agentify:contract:2:*`.
Their validation vocabulary and the runtime contract handshake stay unchanged;
code that indexed the generated documents by the previous `$id` must use the
Agentify identifier.
