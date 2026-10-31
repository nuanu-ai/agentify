# 0023. A connected WooCommerce shop is a merchant credential we hold and fill orders with

Date: 2026-09-14
Status: accepted; developed on equal terms with the SDK (the product owner,
2026-10-11), one of the two at a time (ADR-0036), and offered on every channel
(the product owner, 2026-10-26).

## Context

A WooCommerce owner has a catalogue and no code that answers Agentify orders.
Stock WooCommerce can grant an application a key, serve products, create an
order, grant a protected download
([research 33](../research/33-woo-connect-probe.md)) and price shipping in its
cart for a client with no browser
([research 41](../research/41-woo-parcel-probe.md)), so connecting a shop hands
us a third party's write credential and the duty to give the buying agent
actual goods, which an order number is not.

## Decision

We keep the shop's key and secret as WooCommerce issued them, on the merchant's
account and out of every screen: a boundary against the network, not the host,
which the shop owner can revoke. The callback counts only against the account's
latest Connect, within fifteen minutes and for the shop's root origin. Requests
go only to that checked and pinned public address, with TLS host verification
and no redirect off the shop.

Simple products of two classes are imported by the conditions the merchant
guide lists (`apps/docs/woocommerce.md`); anything else is named and skipped. A
card is priced at every purchase, and its `quote_reference` (ADR-0049) names
the product and settings the fresh read at payment must match. Synchronization
follows the shop's products and preserves merchant pauses (the product owner,
2026-10-30): it takes a card off sale only on the shop's own direct answer
about that product after a complete read, and content the merchant can fix
leaves the last card on sale. It returns to sale only cards the connector
withdrew, and a price question withdraws by the same rule. How a shop is read
and judged is in [research 94](../research/94-woo-catalogue-sync.md).

A download, one non-public file on the shop's origin with no limit or expiry,
sells on an asynchronous card that delivers WooCommerce's permission URL, a
bearer secret. A parcel (the product owner, 2026-10-09) sells from a shop that
ships to the shipping address, within Agentify's seven days (ADR-0033), at the
goods plus the cheapest rate the shop's cart gives the locality; no rate is no
price. Its order ships at a rate that makes up what was paid or is refused
before the shop is called, is taken on once the shop shows the address as sent,
and ships when the shop completes it; the connector keeps nothing of the
address. Tax is ADR-0041 and another currency ADR-0044. Products and settings
are cached briefly and guest carts reused from a small pool per shop address
(the product owner, 2026-10-27); a cart in doubt is never reused, a new one
opens at most once per shop every ten minutes (2026-10-28), and paid orders
never share carts with free questions
([research 90](../research/90-unpaid-price-questions-design.md)).

The connector fills orders as the merchant's worker inside Agentify's process
([research 35](../research/35-one-process.md)); on the live channel a card
sells once the operator approves its merchant. One paid shop order is recorded
per sale before it answers, and its ledger moves forward only: a download whose
shop is silent waits for the next three-hour hand-over (ADR-0004, the product
owner, 2026-10-28), and a create that may have reached the shop is never sent
again on its own. A download's paid failure is recovered only on the merchant's
recovery page, once: under a new grant after the shop refused, or under the
same grant after a silence (the product owner, 2026-10-26); and an unknown
create binds only an order the merchant names that matches every fact of the
sale ([research 54](../research/54-self-service.md)). A mismatch, like a parcel
whose address is erased (ADR-0032), stays unfulfilled; no staffed recovery
queue is part of the service (the product owner, 2026-10-19).

## Rejected

A plugin of ours, which stock WooCommerce makes unnecessary; a buyer's email on
the shop order, which buyers do not give, so it carries the merchant's own
(whose address belongs there is open); the raw file URL or the order number as
goods; a scan inferring that an unknown order is absent, which risks a second
order; shop credentials in the gateway; the rate stored with the price; zones
matched by a matcher of ours (research 37); a time to ship per shop or none; a
stored quote or a new cart per price, which free questions would fill; stopping
a shop's sales for good once a cart is in doubt; and withdrawing a card the
shop's list merely left out, which an incomplete or shifted read can do.
