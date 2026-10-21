---
"@nuanu-ai/agentify-contracts": minor
"@nuanu-ai/agentify": minor
---

The SDK reads what only informs leniently, so an older release keeps working
when Agentify adds to it. A field it does not know on an event, a card, a
receipt, an envelope or around an order is left out of what the merchant's
code receives. An event of a kind it does not know is skipped: the rest of the
poll is handled, and the problem reporter receives one non-fatal
`event_skipped` problem naming the event's type and its order. A word it does
not know reads `unknown` in an order's `status` or `payment_status`, an
event's `reason` and the `result` beside `ok: true`, where the call still
succeeded. A price question for a `purpose` it does not know is left
unanswered with one non-fatal `quote_skipped` problem. The SDK's
`OrderStatus`, `PaymentStatus`, `OrderWithStatus`, `OrderList`, `OrderEvent`,
`OrderCallResult` and `OrderCallResponse` types carry that one extra word.

What an order delivers is read as closed as it is written, off the stream and
read back: an unknown field or address shape there fails the poll or the read
rather than reach the merchant's code with part of the order missing.

On a version mismatch the worker takes no new work, lets handlers already
running send their answers, and then stops.

The contracts package gains `readerOf(schema)`, which makes this reader out of
any of the merchant's documents, with the `Read`, `UnreadEvent` and
`UnknownWord` types and `UNKNOWN_WORD`. The schemas themselves stay closed:
they are what a gateway writes, and a field it was not meant to send is
refused on its side.

Every SDK call names the package's release in its `user-agent` header as
`agentify-sdk/<version>`, the version only when the manifest beside the code
is this package's own. The gateway notes it beside a key's last use whenever
it writes that down. Nothing is refused on it.

`CONTRACT_VERSION` moves from `2` to `3`, once, at the switch from strict to
lenient reading: a release up to 0.7.1 reads strictly, and now stops at its
first poll answer saying it is out of date rather than failing on a later
addition. From here the version moves when a field or a word is renamed or
removed, a field's meaning changes, anything is added to what an order
delivers, or a card mode, selling state or kind of message is added; an
informational field, an event kind or a status, reason, result or purpose
word leaves it alone. Every schema's identity moves with it, to
`urn:agentify:contract:3:<name>`.
