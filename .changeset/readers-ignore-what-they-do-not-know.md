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

`CONTRACT_VERSION` stays `2`. It now moves only when a field or a word is
renamed or removed, or a field's meaning changes, and an added field, event
kind or status word leaves it alone. Releases up to 0.7.1 read strictly while
speaking `2`, so an addition fails their polls rather than stopping them with
words: upgrade them.
