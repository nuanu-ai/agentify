---
"@nuanu-ai/agentify-contracts": patch
---

The answer route and the `not_applicable_in_mode` code now say that a
synchronous order cannot be taken on. An acceptance from a synchronous handler,
or the `accept` call on a synchronous order, is refused with
`not_applicable_in_mode`, because the goods of that mode travel only in the
handler's answer and the `deliver` call that would carry them later does not
exist there.
