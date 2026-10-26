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
us a third party's write credential and the duty to give the buying agent actual
goods, which an order number is not.

## Decision

We keep the shop's key and secret as WooCommerce issued them, on the merchant's
account in the dashboard's database: a boundary against the network, not the
host, which the shop owner can revoke, and no screen is handed the row holding
them. The callback that brings them counts only against the account's latest
Connect, within fifteen minutes and for the shop's root origin, and the shop's
address comes from that Connect, never from the callback. Requests go only to
that checked and pinned public address, with TLS host verification and no
redirect off the shop.

Two classes of simple product are imported from a shop at its root address, by
the conditions the merchant guide lists (`apps/docs/woocommerce.md`), and
anything else is named and skipped. A card is
priced at every purchase, and an accepted price answer durably binds its
`price_id` to a fingerprint of the product and the settings it is sold under,
which the product read at payment must match. A download is virtual and
downloadable, with one non-public file on the shop's own origin, downloadable
without limit or expiry under safe download settings; its asynchronous card
delivers WooCommerce's own download permission URL, which holds the order key
and is a bearer secret shown only in that delivery.

A parcel (the product owner, 2026-10-09), neither virtual nor downloadable,
sells from a shop whose shipping is on and not forced to the billing address,
and ships within seven days, Agentify's constant, since WooCommerce has no field
for the merchant's time to ship (ADR-0033). Its price is the goods and the
cheapest rate the shop's cart gives the locality, and no rate is no price. The
rate is not bound: the order asks again and ships at the rate that makes up what
was paid, or is refused before the shop is called. It is taken on only once the
shop's answer shows the address as sent, Completed in the shop is its shipment,
and the connector keeps and logs nothing of the address.

What a sale from a shop that calculates tax means, and the one-cent match of
every shop's order to its payment, are ADR-0041. A shop priced in another
currency than US dollars sells at a rate its merchant sets, as ADR-0044 records.

The dashboard offers the connector on every channel (the product owner,
2026-10-26), and on the live one an imported card sells only once the operator
has approved its merchant, as any card there does. It fills orders as the
merchant's worker in the process it shares with the gateway ([research
35](../research/35-one-process.md)), recording one paid WooCommerce order per
sale before it answers, so a redelivery returns the stored result. The ledger
moves forward only: a refusal proved before the create request is
`precreate_refused`; once that request is sent the order is `create_unknown`,
never resent on its own, until a validated, correlated answer makes it `placed`,
which delivers without the shop credential and is final for a download; a placed
parcel is followed until it ships or the shop ends it.

A download's paid failure is recovered only on its merchant's recovery page for
one order, never through an SDK method or the operator's workspace; the page
shows a sale and calls the gateway or the shop only for the account that owns
it. After a pre-create refusal the page may create the shop order once, while
the order is unfulfilled, the same shop is connected again under a new grant
and the product still qualifies (the product owner, 2026-10-26). The ledger
becomes `create_unknown` before the request is sent, so no second press
creates again, and the order holds what the buyer paid. The Agentify order is
read again after the shop's checks, just before the ledger moves, so a closure
can still meet a create only between that read and the shop's answer. An
unknown create binds only an order id the merchant supplies, read back and
matched on every fact of the sale. A mismatch stays unfulfilled, as does a
parcel's failure, whose address is gone, and no staffed recovery queue is part
of the service (the product owner, 2026-10-19).

## Consequences

The order carries the merchant's own email, since WooCommerce mails whatever
address is on it; whose address belongs there is an open product question.
Rejected: a plugin of ours, which stock WooCommerce makes unnecessary; a buyer's
email, which buyers do not give; the raw file URL; the order number alone; a
scan inferring an unknown order is absent, which risks a second order in
somebody's shop; shop credentials in the gateway; the rate stored with the
price, a new column for what asking again gives; zones matched by a matcher of
ours, error-prone (research 37); and a time to ship per shop or none, which the
product owner put after the test.
