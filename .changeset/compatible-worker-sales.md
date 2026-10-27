---
"@nuanu-ai/agentify": minor
"@nuanu-ai/agentify-contracts": minor
---

Workers send their contract version before taking work. Contract version 5
requires it on poll requests. The gateway opens API merchant sales only after
a compatible worker connects; older SDKs must be updated. Publishing before
starting a worker remains supported, and already accepted orders remain for
compatible workers to fulfill without another charge.
