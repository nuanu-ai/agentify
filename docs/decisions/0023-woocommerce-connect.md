# 0023. A connected WooCommerce shop is a merchant credential we hold and fill orders with

Date: 2026-09-14
Status: accepted; the connector is experimental

## Context

A WooCommerce owner has a catalogue and no code that answers Agentify orders.
Stock WooCommerce can grant an application a key, serve products, create an
order and grant a protected download (`docs/research/33-woo-connect-probe.md`),
so connecting a shop hands us a third party's write credential and the duty to
give the buying agent actual goods, which an order number is not. The connector
is experimental and not the product's acceptance gate; the SDK is its path.

## Decision

The dashboard keeps the shop's key and secret as WooCommerce issued them, on the
merchant's account in the dashboard's database, a boundary against the network
and not the host; the shop owner can revoke them, and no screen is handed the
row that holds them. The callback that brings them spends, in the transaction
that writes the connection, a random grant row bound for fifteen minutes to the
account and the shop's root origin, and takes the shop address from that row,
never from the callback. The account's next Connect replaces the row, so an
older callback cannot overwrite a newer connection; an expired row is refused
but stays visible to its owner. Requests to a shop go only to a checked and
pinned public address, keep TLS host verification and follow no redirect off the
shop.

The one product class is a single protected download: a published, purchasable,
in-stock simple product in US dollars, virtual and downloadable, without managed
stock and not sold individually, with one non-public same-origin file
downloadable without limit or expiry, from a shop at its root address with tax
calculation off and safe download settings; anything else is named and skipped
at import. The card is asynchronous, priced at purchase and keyed by shop origin
and product id. It delivers WooCommerce's own download permission URL, file name
and order number; the URL holds the order key and a hash of the order's email
and is a bearer secret, shown only in that delivery. An accepted price answer
durably binds its `price_id` to a fingerprint of product, price, file and
settings, which the product read at payment must match.

The dashboard fills the order as the merchant's worker, calling the gateway's
application inside the shared process (ADR-0030): it checks the product again,
claims the order in a ledger, creates one paid WooCommerce order and records its
permission before answering, so a redelivery returns the stored result, never a
second order. The ledger moves forward only: a refusal proved before the create
request is `precreate_refused`; once that request is sent the order is
`create_unknown`, never resent on its own, until a validated, correlated answer
makes it `placed`, which is final and needs no shop credential to deliver. A
private command for one order, not a public route or SDK method, closes paid
failures: a pre-create refusal may create once after the merchant reconnects the
same shop and the product still qualifies; an unknown create binds only an order
id an operator supplies, read back and matched on every fact of the sale. A
mismatch stays a refund owed.

## Consequences

The WooCommerce order carries the merchant's own email, since WooCommerce mails
whatever address is on it; whose address belongs there is an open product
question, and no buyer email is asked for. A card whose product changed or went
stays listed until the merchant pauses it; the price check refuses it before
payment, and a change after the quote becomes a refund owed. Rejected: a plugin
of ours, which stock WooCommerce makes unnecessary; a buyer's email, which
buyers do not give; the raw file URL; the order number alone; a scan inferring
an unknown order is absent, which risks a second order in somebody's shop; and
shop credentials in the gateway.
