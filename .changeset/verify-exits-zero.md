---
"@nuanu-ai/agentify": minor
---

`agentify verify` answers `0` when every card it was given is complete as far
as the contract can tell, `1` when a card has findings and `2` when it was
called with something it cannot work from, the bare command included. It no
longer counts a handler's idempotency as a check that "could not be run" and
answers `3` for a complete card, which a build read as a failure: whether a
handler holds against an order delivered twice is not something a command
holding only card files can try, and the output says so and that a test
purchase proves it.
