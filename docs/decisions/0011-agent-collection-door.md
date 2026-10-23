# 0011. A buyer's key opens an order; its identifier only names it

Date: 2026-08-27
Status: accepted; revised 2026-10-19 (the product owner): fit for a public
audience; revised 2026-10-20: what the status shows of a paid order; revised
2026-10-23 (the product owner): the identifier names an order, a buyer key
opens it

## Context

An agent that buys an asynchronous product receives an order before the goods
exist and collects them later from the order's status route, so that route
needs a rule for who may ask. Merchants have keys; buyers deliberately do not,
as registering would undo buying with no prior relationship. The order's
identifier reaches the merchant's code, the dashboard, receipts and the
WooCommerce order's meta, and merchants pass it to their own systems as an
idempotency key, so it ends up in logs, CRMs and suppliers' inboxes. The
payment requirements reach the payment facilitator at every verification and
charge, and the x402 Bazaar (ADR-0012) publishes a listed resource's
requirements with `extra` as the last paying request carried it.

## Decision

Every order is created with a buyer's key: random, as hard to guess as a
version-4 UUID, kept beside the order as issued and never shared by two orders.
It reaches only the agent that bought, as the one path segment of `status_url`
(`/x402/orders/:buyer_key/status`) in the purchase's answer and in the status
document. Holding that address is the proof, on both channels. The status
route finds an order by the key alone and answers an order identifier, or any
other value, exactly as a key that names no order, with one `no_such_order`
and `Cache-Control: no-store`. A buyer who lost the purchase answer and signs
the kept challenge again is given the original answer, with the same address.
The key is never written into anything the merchant reads (the SDK's orders,
worker envelopes, the dashboard, WooCommerce meta, receipts), the payment
requirements, the facilitator's calls, analytics or a log line.

The key sits in the path rather than beside the identifier in a query because
an address that carried the identifier would invite a gateway to answer by it,
and an agent to build addresses from it; with one segment there is one value to
look up and nothing to compare.

The identifier is a plain reference: it names the order, opens nothing, and may
be logged and passed on freely. The status document keeps `order_id` as what
the buyer quotes to the seller; its description and `llms.txt` say that
`status_url` is the key and not to be shared, while `order_id` is not a secret.
The payment requirements name the order by it, `accepts[].extra.order_id`, and
a paid request is bound to the order it names; an order belongs to the payer
bound to its first verified payment, so a published identifier buys nothing.
The document, `agentOrderStatusOf` in `apps/gateway/src/app/runner.ts`, is
built field by field and carries what the buyer may know: never the merchant's
product key, what the buyer sent or any other order.

## Consequences

Anyone who obtains a status address through a proxy or an agent's own store can
read that order, though not change it, act as its payer or list other orders:
for a parcel its tracking, whose carrier page may show the buyer's city
(ADR-0033), for every order the seller's name and site (ADR-0034), and for a
paid one the transaction that paid it, which leads to the buyer's wallet.
Anyone who learns an unpaid order's identifier can pay for it at its full price
before its buyer does; the buyer's payment is then refused and nothing of theirs
is taken.

## Alternatives rejected

The identifier as the proof, with a separate payment reference in the
requirements: every party that saw the identifier, the merchant, their shop,
logs, the payment side, needed its own patch to keep it secret. Keeping the
reference beside the identifier once neither is secret is a second name nothing
needs. Accounts and keys for buyers turn buying into signing up. Proving
control of the paying address with x402's Sign-In-With-X remains the long-term
direction; not now, as it asks every buyer's client for a second signature that
few are known to give.
