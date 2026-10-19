---
"@nuanu-ai/agentify-contracts": patch
---

Enforce the existing fulfillment-dependent card rules in generated JSON Schema,
including cards embedded in merchant catalog responses. Synchronous and
asynchronous cards require a declared result; parcel cards require their shipping
time and price handler, and refuse declared results and delivery deadlines.
The export continues to describe normalized cards with an explicit fulfillment
mode, while runtime validation keeps its field-specific publication errors.
