# Bounded merchant worker throughput

The SDK process and each connected WooCommerce account have one poll producer
and at most four unfinished envelopes. An envelope includes its handler and
answer request; an event waiting for its order's earlier handler also occupies
a place. A concurrent order redelivery does not start another fulfillment.
The gateway still decides retries, deadlines and delivery attempts.

This removes the serial wait behind one slow handler. Four occupied places
still stop polling and can delay a price past its deadline. This is a capacity
bound, not a latency or throughput guarantee. It does not bound all outbound
HTTP requests: a WooCommerce quote's timed-out reads can finish later.

## Verification protocol

Predictions and decision rule, fixed before the standalone probe:

- With one order held in fulfillment, another order and a price question finish
  before it is released, in both integrations.
- Four held orders stop the producer before a fifth draw. Releasing one admits
  the fifth. An in-flight repeat produces neither another fulfillment nor a
  premature WooCommerce refusal.
- An SDK event for the held order waits for that handler, while unrelated work
  progresses. Shutdown waits for started work and draws nothing more.
- A disconnected WooCommerce loop retains ownership while work finishes, so
  reconnect cannot create a second producer and shutdown cannot abandon it.

Acceptance requires these behaviors, deterministic regression tests, mutation
checks that fail on removed guards, a negative control with a throwing handler,
and independent technical and merchant-documentation reviews. The standalone
probe imports the production client, worker and WooCommerce ledger, uses a
manually implemented loopback gateway and shop, and imports no shared fixture
or testing helpers. It sends no chain transaction or live merchant request.

## Results

The red run fails nine targeted cases on the serial implementation. The green
SDK and WooCommerce suites pass 233 tests across 15 files, including the
throwing-handler negative control, same-subscription retry, queued events and
reconnect after the retiring owner drains.

The standalone probe passes for both integrations: another order and price
answer before the held order, one fulfillment per identifier, and the
WooCommerce ledger durably records creation. The SDK uses a hand-written HTTP
gateway; the connector uses its in-process gateway interface and posts to a
loopback shop through its fulfillment seam. This does not test live shop
qualification, payment or external transport reliability.

Eight final mutations are killed: both capacity limits, SDK duplicate
coalescing, retry cleanup, event-tail cleanup and shutdown drain, and
WooCommerce duplicate coalescing and retiring ownership. None survives or
fails to apply in the final run. One initial duplicate mutation survives
because the test observes only the start of the retry; an assertion after the
original attempt's event closes that gap before the final run.

Independent technical and merchant-documentation reviews find no runtime
blocker; the documentation review's price-queue correction is applied. Full
repository checks and CI are pending. No test-channel or production deployment
is part of this change; these checks establish neither live shop capacity nor
a price deadline.
