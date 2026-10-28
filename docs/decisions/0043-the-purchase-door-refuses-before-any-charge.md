# The purchase door refuses before any charge

Status: the product owner's words of 2026-10-27: "A request nobody paid for may
use a moment of a merchant's capacity and holds nothing over time" and "Work
that is paid for never waits behind work that is not." The owner also requires
one merchant's load not to slow another. The engineering choices below implement
that rule; shared pool and facilitator isolation remain open in
[research](../research/90-unpaid-price-questions-design.md).

## Context

A caller can ask prices without buying. Holding a place until a price expires
lets such a caller stop a merchant's sales for free. Merchant work still needs
an admission bound before its queue grows longer than the time left to answer.

## Decision

Unpaid prices hold no order or outstanding-purchase counter (ADR-0049). A gate
per merchant bounds active price questions and their arrival rate, shared by
SDK and WooCommerce fulfillment. It admits only work that fits the price
response window, discards questions whose wait ended, and selects ready paid
orders ahead of price questions. It does not preempt a running handler or
reserve an SDK execution slot. Limits are internal constants, not settings.

Engineering choices: four active price questions and sixteen admissions per
second per merchant; one payment verification per merchant and four per gateway process.
The latter leaves database room outside the admission transactions and prevents
one merchant taking every verification slot. Actual upstream requests retain
their permits until bounded completion. These are not measured shop capacity. Overflow on a
synchronous card uses its existing silent-price fallback and card price; the
merchant can refuse before any charge. Other modes answer `seller_busy`, HTTP
429 with `Retry-After: 2`, before any order or charge. Cards remain listed.

Every purchase is refused with `seller_not_taking_orders` while no compatible
process of the merchant's own code has polled for ten minutes, before pricing
and again before its first payment is verified. A payment releasing goods
already made continues. Contact records the worker contract, at most every
thirty seconds per process; its first compatible poll restores admission.
A connector runs inside Agentify and is exempt from this contact rule.

The catalogue omits a silent merchant's cards and restores them on contact.
A GET or empty POST still answers with a listing challenge, preserving outside
discovery listings through a temporary silence. Paused cards stay paused.
`seller_busy` and `seller_not_taking_orders` are retryable and charge nothing.

## Alternatives rejected

Fifty unpaid orders per merchant: anybody could keep all places occupied and
stop sales without paying. A limit per wallet before payment: no authenticated
wallet exists there. Fair lanes and reserved worker capacity are deferred until
observed contention justifies their added contracts. A stored selling pause
would need manual resumption after an ordinary worker restart.
