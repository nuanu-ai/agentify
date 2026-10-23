---
"@nuanu-ai/agentify": minor
"@nuanu-ai/agentify-contracts": minor
---

A message on the worker stream this release cannot read, such as an order
carrying a field added after it, no longer fails the whole poll answer. The
worker sets that one message aside unanswered and reports an `unread` problem
naming the fields, says a newer release may read it only when every field that
failed is one added rather than one broken, and handles the rest of the answer
without the wait that follows a failed poll. The contracts' reader marks such
a message as an `UnreadEnvelope`.

The worker reads a poll answer's contract version before its messages, so a
gateway of another version stops it with `contract_version_mismatch` even when
the messages inside are ones this release cannot read.

An event of a kind this release does not know, and a price question for a
purpose it does not know, are reported as `unread` too: the problem kinds
`event_skipped` and `quote_skipped` are removed, and code that branches on them
branches on `unread` instead.

`orders.list` no longer fails as a whole when one order in it cannot be read.
It returns every order it can read, leaves out the ones it cannot, and reports
one `unread` problem naming the orders left out, the first ten by identifier
and the fields that failed, with the rest counted; the same problem counts the
orders whose status is a word this release does not know, which read `unknown`
and which a loop over open orders leaves alone. `orders.get` of an order it
cannot read still throws, naming the fields. The contracts' reader marks such
an order in a list as an `UnreadOrder`.

An order on the stream that this release cannot read is described as carrying
something the contract version it speaks does not allow, which a newer release
may read; only an event of a new kind and a price question's new purpose, which
the contract adds without a new version, are said to be read by a newer release.

A failure about an answer that was JSON but not the route's document names the
route and the fields that did not fit, with what was expected there, and no
longer quotes the answer, which could carry the buyer's parameters. An answer
that is not JSON is still quoted.
