---
"@nuanu-ai/agentify-contracts": minor
"@nuanu-ai/agentify": minor
---

The SDK reads every gateway answer leniently, so an older release keeps working
when Agentify adds to what it sends. A field it does not know, at any depth of
an order, an event or any other answer, is left out of what the merchant's code
receives. An event of a kind it does not know is skipped: the rest of the poll
is handled, and the problem reporter receives one non-fatal `event_skipped`
problem naming the event's type. An order read with `orders.get` or
`orders.list` whose `status` or `payment_status` holds a word it does not know
comes back with that word as `unknown`; the SDK's `OrderStatus`,
`PaymentStatus`, `OrderWithStatus` and `OrderList` types carry that one extra
word.

The contracts package gains `readerOf(schema)`, which makes this reader out of
any of its schemas, with the `Read`, `UnreadEvent` and `UnknownWord` types and
`UNKNOWN_WORD`. The schemas themselves stay closed: they are what a gateway
writes, and a field it was not meant to send is refused on its side.

Every SDK call names the package's release in its `user-agent` header as
`agentify-sdk/<version>`, and the gateway records the last one seen on each
key. Nothing is refused on it.

An event of a known kind whose `reason` the SDK does not know reaches the
event handler with the reason as `unknown`, and an order call answered
`ok: true` with a `result` word it does not know counts as done, the word read
as `unknown`. The SDK's `OrderEvent`, `OrderCallResult` and
`OrderCallResponse` types carry that word.

`CONTRACT_VERSION` moves from `2` to `3`, once, at the switch from strict to
lenient reading: a release up to 0.7.1 reads strictly, and now stops at its
first poll answer saying it is out of date rather than failing on a later
addition. From here the version moves only when a field or a word is renamed
or removed, or a field's meaning changes; an added field, event kind, status,
reason or result word leaves it alone. Every schema's identity moves with it,
to `urn:agentify:contract:3:<name>`.
