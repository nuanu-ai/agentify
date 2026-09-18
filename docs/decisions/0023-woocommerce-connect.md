# 0023. A connected WooCommerce shop is a merchant credential we hold and fill orders with

Date: 2026-09-14
Status: accepted

## Context

A WooCommerce owner has a catalogue and no code that can answer Agentify
orders. Stock Woo can grant a key, read products, create an order and grant a
protected download without an Agentify plugin. Connecting it gives us a third
party's write credential and makes Agentify responsible for returning actual
goods to the buying agent. An order number is not a product.

## Decision

**Cabinet keeps the shop key and secret as Woo issued them.** They live on the
merchant account under the same host boundary as the cabinet key. Woo can
revoke them. The database is a boundary against the network, not the host.

**The callback spends one random grant row and writes the connection atomically.** It is bound to the account and
root shop origin and expires after fifteen minutes. A live callback deletes it;
an expired callback is refused while the attempt remains visible. That
account's next Connect supersedes it, so an older callback cannot replace a
newer connection. Another account never sweeps it. The shop address comes from
the row, never callback input. Each connection gets a private revision.

**The working product is one protected native download.** Import accepts a
published, purchasable, in-stock, unmanaged-stock simple USD product that is
virtual, downloadable, not sold individually or taxable, and has one protected
same-origin file with unlimited count and expiry. Taxes are disabled and the
safe download settings are authoritative. Public raw files and everything
outside this class are named and skipped.

The card is asynchronous and live-priced. Its identity binds shop origin and
Woo product id. Delivery is Woo's native permission URL, file name and order
number. The URL contains Woo's order key and a hash of the merchant order email,
contains no email, and is a bearer secret rather than wallet-bound. It appears
only in that order's delivery.

Every accepted quote durably binds its `price_id` to a digest of the root shop
origin, product, amount/currency, download id/name, protected source address and
supported settings. The paid order must carry that price id and the fresh
authoritative product must match. The protected address is never stored.

**Cabinet fills the order as the merchant's worker.** After Agentify settles,
Cabinet rechecks the product and settings, claims the Agentify order, creates
one paid Woo order and durably records the permission ingredients before
answering. Redelivery returns the stored result and never creates a second Woo
order. The ledger phase is `precreate_refused`, `create_unknown` or `placed`;
only a refusal proved before POST is `precreate_refused`. Every response or
failure after POST that does not validate a complete correlated result remains
`create_unknown` and never reopens POST. A placed result can be delivered after
disconnect or shop switch because it needs no Woo credential.

**A private exact-order command closes paid failures.** A pre-create refusal may
make one POST only after the same origin reconnects under a new revision and
the sold product still passes preflight. An unknown create requires an
operator-supplied Woo id and authenticated GET-by-id. Exact shop, transaction,
metadata, merchant, product, quantity, amount, currency, paid state and native
permission facts are required before idempotent late delivery. Mismatch remains
refund debt. This adds no public route or SDK method.

## Consequences

Woo orders use the merchant's email; no buyer email is requested or exposed.
Managed stock, physical and variable goods, gifts/vouchers, multiple files,
finite permissions and external file stores are unsupported. Import reads at
most two hundred products, qualifies at most four concurrently, and stops after
the first unknown publish result.
Stale cards remain visible, but a fresh authoritative quote refuses unsupported
state before payment; a change after quote can become visible refund debt.

All outbound Connect, catalogue, authenticated REST, recovery and raw-file
requests resolve only public addresses, pin the approved address, preserve TLS
host verification and refuse redirects. Non-root WordPress paths are refused.
A different origin cannot fulfil a card imported from the previous one.

Rejected: an Agentify Woo plugin, buyer-email delivery, raw file URLs,
order-number-only delivery, automatic scans that infer an unknown order is
absent, and putting shop credentials in Gateway.
