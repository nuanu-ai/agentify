# 0004. Worker transport: HTTP long polling

Date: 2026-08-26
Status: accepted

## Context

By default a merchant receives orders from our queue through an SDK worker
subscription (ADR-0002), and the portal promises that the same subscription
carries price questions (ADR-0002 §2) and order events.

## Decision

1. The worker channel is HTTP long polling against the gateway, authenticated
   by the merchant's API key. The SDK's worker asks for a wait window of about
   25 seconds; the gateway holds the poll for the smaller of that and its own
   window, until something arrives or the window closes, and answers with one
   envelope or none, whatever number is asked for. The wait for a handler's
   answer starts at the hand-over and a worker works one envelope at a time, so
   orders at the back of a batch would be taken for silences and resent, each
   resend spending a delivery. A poll draws past an envelope it may not hand
   out, such as an order that closed while queued, instead of answering empty
   and sending the worker to rest, until its window ends or a fixed number
   have been passed. The price is a round trip per envelope, with a price
   question waiting behind whatever is ahead of it; more instances are the
   remedy.
2. One envelope stream carries three kinds, each under its kind marker: an
   order, a price question and an order event. A price question is answered on
   its own route against its `price_id`, and an event by nothing. The SDK posts
   what an order's handler returns to the order's answer route in every mode;
   in the synchronous mode that is the only answer, and the asynchronous mode's
   explicit `deliver` and `refuse` calls are refused there as
   `not_applicable_in_mode`. Goods are held to the card before lateness is
   read, so a late synchronous answer is refused as
   `delivery_does_not_match_card` if they do not fit and is otherwise a success
   carrying `purchase_already_closed`. A repeat answer to an order already
   carrying goods is `already_delivered` with no second check, so a retry is
   safe.
3. An order is delivered at least once and an event at most once. The queue
   finishes every envelope as it hands it over and never offers it again.
   Whether an unanswered order goes out again is the order machine's decision,
   against the order's own attempts and deadline, and the resend is a fresh
   envelope around the same order, so a handler has to survive seeing an order
   twice and recognise it by the order's identifier. An event lost in a poll
   response that never reached its worker is gone, and no event is the only
   record of anything: its order stays in `orders.list({ open: true })` until
   whatever it owes, a refund included, is settled.
4. A connected, waiting worker receives a message with no polling lag: its poll
   is parked at the gateway and woken on publish, so an agent waiting on the
   price question of a synchronous purchase waits on the network alone.
5. The SDK hides the transport: a merchant registers handlers with
   `on(kind, handler)`, one per kind, and opens the channel with `start()`, the
   loop over the poll call, so changing the transport changes no merchant code.

## Consequences

A merchant who treats events as a complete notification channel misses some,
silently on both sides; the portal tells them to walk their open orders on a
schedule, and whether a stronger promise is owed is open. The SDK reports only
refused answers, so it drops `purchase_already_closed`; `apps/docs/orders.md`
lists that gap as open.

WebSocket is rejected as a persistent-connection stack bought for nothing we
need, plus custom framing the hand-rolling rule (ADR-0003 §9) forbids; it is
revisited on a measured latency or throughput need long polling cannot meet, or
on fan-out to many workers per merchant. Server-Sent Events go one way, so
answers would need a second surface anyway. Webhooks as the default fall to
ADR-0002: the merchant would have to expose a public endpoint. A batch a poll,
each order's wait started by its place in the batch, guesses at handler times
and notices a dead worker late; a call by which a worker reports starting each
order adds to the wire what one envelope a poll gives. Answers carried in the
next poll would tie the synchronous answer to polling cadence, which §4 keeps
out of its path. Redelivery by the queue's visibility timeout would be a second
opinion over the order machine's (§3). Draining a queue has precedents in
`docs/research/12-big-players-merchant-integration.md`.
