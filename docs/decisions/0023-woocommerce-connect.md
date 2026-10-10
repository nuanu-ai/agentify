# 0023. A connected WooCommerce shop is a merchant credential we hold and fill orders with

Date: 2026-09-14
Status: accepted; the connector is experimental and offered off the live
channel only: there the dashboard mounts none of its screens and runs no
worker, so a connection made there earlier stays unused and its cards' price
questions go unanswered, refusing every sale before payment. Parcels were added
on the product owner's word on 2026-10-09 and sell on the test channel only, as
every parcel does (ADR-0033).

## Context

A WooCommerce owner has a catalogue and no code that answers Agentify orders.
Stock WooCommerce can grant an application a key, serve products, create an
order and grant a protected download (`docs/research/33-woo-connect-probe.md`),
and its Store API cart prices shipping for a client with no browser
(`docs/research/41-woo-parcel-probe.md`), so connecting a shop hands us a third
party's write credential and the duty to give the buying agent actual goods,
which an order number is not. The connector is experimental and not the
product's acceptance gate; the SDK is its path.

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

Two product classes are imported, both published, purchasable, in-stock simple
products in US dollars without managed stock and not sold individually, from a
shop at its root address with tax calculation off; anything else is named and
skipped at import. Every card is priced at purchase and keyed by shop origin and
product id, and an accepted price answer durably binds its `price_id` to a
fingerprint of the product and the settings it is sold under, which the product
read at payment must match.

A download is virtual and downloadable, with one non-public same-origin file
downloadable without limit or expiry, from a shop with safe download settings.
Its card is asynchronous. It delivers WooCommerce's own download permission
URL, file name and order number; the URL holds the order key and a hash of the
order's email and is a bearer secret, shown only in that delivery.

A parcel is neither virtual nor downloadable, from a shop whose shipping is on
and not forced to the billing address. Its card ships (ADR-0033) with seven
days to ship from one constant in the connector: Agentify's stand-in, stated on
the import screen, until parcels sell on the live channel and the time comes
from the merchant. Its price is the goods and the cheapest rate the shop's cart
gives for the question's locality; no rate is no price. The rate is not
bound: the order asks again, and ships at the rate costing what was paid above
the goods or is refused before the shop is called. It is taken on only once the shop's answer shows the address as
sent, and Completed in the shop is its shipment. The connector keeps and logs
nothing of the address; the mechanics are in research 41.

The dashboard fills the order as the merchant's worker, calling the gateway's
application inside the shared process (ADR-0030): it checks the product again,
claims the order in a ledger, creates one paid WooCommerce order and records its
permission, or a parcel's shop order, before answering, so a redelivery returns
the stored result, never a second order. The ledger moves forward only: a
refusal proved before the create request is `precreate_refused`; once that
request is sent the order is `create_unknown`, never resent on its own, until a
validated, correlated answer makes it `placed`, which needs no shop credential
to deliver and is final for a download; a placed parcel is followed until it
ships or the shop ends it. A private command for one order, not a public route
or SDK method, closes a download's paid failures: a pre-create refusal may
create once after the merchant reconnects the same shop and the product still
qualifies; an unknown create binds only an order id an operator supplies, read
back and matched on every fact of the sale. A mismatch stays a refund owed, and
so does a parcel's, whose address is gone by then.

## Consequences

The WooCommerce order carries the merchant's own email, since WooCommerce mails
whatever address is on it; whose address belongs there is an open product
question, and no buyer email is asked for. A card whose product changed or went
stays listed until the merchant pauses it; the price check refuses it before
payment, and a change after the quote becomes a refund owed, as does a
parcel's rate changed in between. A parcel's price question leaves a two-day
guest session with the locality in the shop, a state WooCommerce writes its own
way (`DE-BE`) is no price, and Completed tells the buyer it shipped, for good.
A parcel's order the shop may have made without confirming it is refused while
the shop may hold it paid, and the merchant is told not to ship it.
Rejected: a plugin of ours, which stock WooCommerce makes unnecessary; a buyer's
email, which buyers do not give; the raw file URL; the order number alone; a
scan inferring an unknown order is absent, which risks a second order in
somebody's shop; shop credentials in the gateway; the rate stored with the
price, a new column for what asking again gives; zones matched by a matcher of ours,
error-prone (research 37); and a time to ship stated per shop or none at all,
which the product owner put after the test.
