---
"@nuanu-ai/agentify": minor
"@nuanu-ai/agentify-contracts": minor
---

Your worker now sends its contract version on every poll, and the gateway
takes work only from a worker that speaks its contract version, 6 in this
release. Your sales through the SDK open only once such a worker has connected, so a
worker on an older SDK has to be upgraded. You can still publish cards before
you start a worker, and orders already accepted stay for a compatible worker
to fulfill, without another charge.
