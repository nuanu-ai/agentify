---
"@nuanu-ai/agentify": patch
---

A call that Agentify failed while handling, answered with a 5xx, is no longer
described as one that did not go through, because such a failure can come
after the call took effect. The message now says that Agentify failed while
handling it, and the gateway's own words follow. Codes and `retryable` are
unchanged.
