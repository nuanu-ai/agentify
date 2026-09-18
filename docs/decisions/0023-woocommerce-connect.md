# 0023. A connected WooCommerce shop is a merchant credential we hold and fill orders with

Date: 2026-09-14
Status: accepted

## Context

A WooCommerce owner has a catalogue and no code that can answer Agentify
orders. The stock Woo REST API can grant a key, read products and create an
order without an Agentify plugin. Connecting it gives us a third party's
write credential and a public callback. Selling from it also makes Agentify
responsible for carrying the actual product to the buying agent, not merely a
shop order number.

Stock Woo can grant a native protected download to a paid order. That is the
smallest product this connector can honestly complete. Gift cards without a
voucher implementation, physical goods and other product classes have no goods
this connector can return to an agent.

## Decision

**Cabinet keeps the shop key and secret as Woo issued them.** They live on the
merchant account under the same host boundary as the cabinet key. Woo's own
REST API screen can revoke them. The database is a boundary against the
network, not against the host.

**The grant callback spends one random state row.** The value is bound to the
account and normalized shop origin, expires after fifteen minutes and is
deleted by the callback. Shop address comes from that row, never from callback
input. Each successful connection gets a private revision.

**The working product is one protected native download.** Import accepts only
a published, purchasable, in-stock, unmanaged-stock simple USD product that is
virtual and downloadable, has exactly one enabled same-origin protected file,
unlimited count and expiry, and safe shop download settings. The raw file must
not be publicly retrievable. Everything else is named and skipped.

The published card is asynchronous and asks Cabinet for a live price before
payment. Its merchant item identity binds normalized shop origin and Woo
product id. Its delivery is the native Woo permission URL, file name and Woo
order number. The URL uses Woo's order key and hashed merchant order email; it
contains no buyer or merchant email and is a bearer secret, not wallet-bound.
It appears only in the order delivery.

**Cabinet fills the order as the merchant's worker.** Agentify settles an
asynchronous purchase before hand-over. Cabinet rechecks the authoritative
product and settings, claims the Agentify order in a durable ledger, creates
one paid Woo order and records the exact permission ingredients before
answering with the goods. Redelivery returns that stored result and never
creates a second Woo order.

The ledger records one of `precreate_refused`, `create_unknown` or
`placed`, plus shop origin and connection revision, immutable sold facts and
the Woo result. Any response loss, retry status, malformed successful response
or failure to record a successful create is unknown and never reopens POST.

**A private exact-order command closes paid failures.** It adds no public route
or SDK method. A known pre-create refusal may make one new POST only after the
same shop reconnects under a new revision and the exact sold product still
passes preflight. An unknown create requires an operator-supplied Woo order id
and makes only authenticated GET-by-id. It binds and delivers only when shop,
Agentify transaction and metadata, merchant, product, quantity, amount,
currency, paid state and native permission all match. Missing or mismatched
facts remain refund debt. Late delivery uses Agentify's existing idempotent
delivery route.

## Consequences

Woo orders use the merchant's own email until buyer identity is decided; no
buyer email is requested or exposed. Managed stock, physical and variable
products, gift/voucher semantics, multiple files, finite permissions and
external file stores are unsupported.

Import reads at most two hundred products and never silently resumes a paused
card. Removing or changing a Woo product does not remove its Agentify card; the
live price check refuses stale unsupported state before payment where it can,
and the residual change after quote is honest refund debt.

Connect preflight and same-origin file protection checks are outbound requests
to merchant-chosen HTTPS. Private-address protection remains owed before
Cabinet shares a sensitive network. One account has one connected shop; a
different origin cannot fulfil cards imported from the previous one.

Rejected: an Agentify Woo plugin, buyer email as a delivery mechanism, raw file
URLs, order-number-only delivery, automatic collection scans that infer an
unknown order is absent, and putting shop credentials in Gateway.
