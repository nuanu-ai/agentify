---
"@nuanu-ai/agentify": minor
"@nuanu-ai/agentify-contracts": minor
---

A message on the worker stream this release cannot read, such as an order
carrying a field added after it, no longer fails the whole poll answer. The
worker sets that one message aside unanswered and reports an `unread` problem
naming the fields, says a newer release reads it only when every field that
failed is one added rather than one broken, and handles the rest of the answer
without the wait that follows a failed poll. The contracts' reader marks such
a message as an `UnreadEnvelope`.

The worker reads a poll answer's contract version before its messages, so a
gateway of another version stops it with `contract_version_mismatch` even when
the messages inside are ones this release cannot read.

`orders.list` reports one `unread` problem counting the orders whose status is
a word this release does not know, which read `unknown` and which a loop over
open orders leaves alone.

A failure about an answer that was JSON but not the route's document names the
route and the fields that did not fit, with what was expected there, and no
longer quotes the answer, which could carry the buyer's parameters. An answer
that is not JSON is still quoted.
