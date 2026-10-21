---
"@nuanu-ai/agentify": minor
---

Handle up to four stream messages concurrently through one poll producer, so a slow order no longer blocks unrelated orders and quotes while capacity is available. Preserve same-order event ordering, coalesce in-flight order redeliveries, and wait for all started handlers during shutdown. Handlers for different orders may now overlap; fulfillment still needs idempotency by order identifier.
