# 0023. A connected WooCommerce shop is a merchant credential we hold and fill orders with

Date: 2026-09-14
Status: accepted; developed on equal terms with the SDK (the product owner,
2026-10-11), one of the two at a time (ADR-0036), and offered on every channel
(the product owner, 2026-10-26). On 2026-10-27 the product owner approved short
caches of a shop's products and settings and a small pool of reused guest
carts; on 2026-10-28 he decided that a cart whose state is in doubt is never
used again and that a new one is opened automatically at most once per shop
every ten minutes.

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
account: a boundary against the network, not the host, which the shop owner can
revoke, and no screen is handed the row holding them. The callback counts only
against the account's latest Connect, within fifteen minutes and for the shop's
root origin, which comes from that Connect. Requests go only to that checked and
pinned public address, with TLS host verification and no redirect off the shop.

Simple products of two classes are imported by the conditions the merchant
guide lists (`apps/docs/woocommerce.md`); anything else is named and skipped. A
card is priced at every purchase. The price answer's `quote_reference`, stamped
with the price (ADR-0049), names the product and the settings it is sold under,
and the fresh read at payment must match it. A product read is reused for five
seconds and the settings for three minutes. A download, with one non-public
file on the shop's origin and no download limit or expiry, sells on an
asynchronous card that delivers WooCommerce's permission URL, a bearer secret.

A parcel (the product owner, 2026-10-09) sells from a shop whose shipping is on
and not forced to the billing address, and ships within seven days, Agentify's
constant (ADR-0033). Its price is the goods and the cheapest rate the shop's
cart gives the locality; no rate is no price. The order asks again and ships at
the rate that makes up what was paid, or is refused before the shop is called.
It is taken on once the shop shows the address as sent, Completed is its
shipment, and the connector keeps and logs nothing of the address. Tax and the
one-cent match are ADR-0041; another currency is ADR-0044.

Carts belong to the shop's address: two accounts connected to one shop share
them and the ten-minute allowance, while keys and caches stay per account. A
cart is retired only when a change's outcome is unknown or the shop refuses its
session; opening a slot's first cart and renewing an idle empty one before it
expires do not spend the allowance. Paid orders have carts that free questions
never take, and polling never waits for a cart. The counts are in
[research 90](../research/90-unpaid-price-questions-design.md).

The connector fills orders as the merchant's worker inside Agentify's process
([research 35](../research/35-one-process.md)); on the live channel an imported
card sells once the operator approves its merchant. One paid WooCommerce order
is recorded per sale before it answers, and the ledger moves forward only:
`precreate_refused` for a refusal proved before the create request, then
`create_unknown` once it is sent, never resent on its own, until a validated,
correlated answer makes it `placed`. A placed download is final; a placed parcel
is followed until it ships or the shop ends it. A download's paid failure is
recovered only on the merchant's recovery page for one order: after a
pre-create refusal it may create the shop order once, for a shop connected again
whose product still qualifies (the product owner, 2026-10-26), and an unknown
create binds only an order the merchant names, matched on every fact of the sale
([research 54](../research/54-self-service.md)). A mismatch, like a parcel whose
address is erased (ADR-0032), stays unfulfilled; no staffed recovery queue is
part of the service (the product owner, 2026-10-19).

## Consequences

The shop order carries the merchant's own email, since WooCommerce mails the
address on it; whose address belongs there is open. Rejected: a plugin of ours,
which stock WooCommerce makes unnecessary; a buyer's email, which buyers do not
give; the raw file URL or the order number as goods; a scan inferring that an
unknown order is absent, which risks a second order; shop credentials in the
gateway; the rate stored with the price, a column for what asking again gives;
zones matched by a matcher of ours, error-prone (research 37); a time to ship
per shop or none, put after the test by the product owner; a stored quote per
price, which free questions would fill; a new cart per price, which leaves a
session in the shop for every question; and stopping a shop's sales for good
once its carts are in doubt, when an unknown change only forbids reusing that
cart.
