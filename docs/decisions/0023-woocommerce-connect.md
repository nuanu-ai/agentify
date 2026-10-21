# 0023. A connected WooCommerce shop is a merchant credential we hold and fill orders with

Date: 2026-09-14
Status: accepted; the connector is developed on equal terms with the SDK (the
product owner, 2026-10-11), a merchant sells through one of the two at a time
(ADR-0036), and it is offered off the live channel only until its orders pass
end to end on the test channel: there the dashboard mounts none of its screens
and runs no worker, so a connection made there earlier stays unused. Parcels were added
on the product owner's word on 2026-10-09 and sell on the test channel only, as
every parcel does (ADR-0033). Shops that calculate tax are sold from wherever it
is clear what to do (the product owner, 2026-10-21); where that is, research 56
measured.

## Context

A WooCommerce owner has a catalogue and no code that answers Agentify orders.
Stock WooCommerce can grant an application a key, serve products, create an
order and grant a protected download (`docs/research/33-woo-connect-probe.md`),
and its Store API cart prices shipping for a client with no browser
(`docs/research/41-woo-parcel-probe.md`), so connecting a shop hands us a third
party's write credential and the duty to give the buying agent actual goods,
which an order number is not.

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
shop at its root address whose tax is off or calculated by WooCommerce itself;
anything else is named and skipped at import. Every card is priced at purchase and keyed by shop origin and
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
bound: the order asks again, and ships at the rate that makes up what was paid
or is refused before the shop is called. It is taken on only once the shop's
answer shows the address as sent, and Completed in the shop is its shipment. The connector keeps and logs
nothing of the address; the mechanics are in research 41.

Where WooCommerce calculates tax, the rule is research 56's
(`docs/research/56-woo-tax-probe.md`): an order line that names the product
alone lets the shop split the tax out of a gross price exactly, and the cart
quotes what the order then charges, except where a shop keeps one gross price
for every buyer by a filter no outside reader sees. So a download sells only
where prices are entered with tax, at its price, taxed at the shop's own
address because its order has none; a parcel sells at its cart's total for the
locality, tax based on the shipping address, and from an inclusive shop only to
a locality whose cart taxes the goods as a cart at the shop's own address does;
and either sells only from a shop rounding tax at the subtotal, since rounding
per line its cart and order can round a half cent of tax apart.
An order from any shop is taken on when its total is equal to what was paid,
or within one cent, the difference recorded (the product owner, 2026-10-21),
and a taxed order's tax is recorded as the shop wrote it. A
catalogue shown otherwise than prices are entered, and tax from an outside
service, are not sold from. With tax off an order's tax must be nothing.

The dashboard fills the order as the merchant's worker, calling the gateway's
application inside the shared process (`docs/research/35-one-process.md`): it
checks the product again, claims the order in a ledger, creates one paid
WooCommerce order and records its permission, or a parcel's shop order, before
answering, so a redelivery returns the stored result, never a second order. The
ledger moves forward only: a refusal proved before the create request is
`precreate_refused`; once that request is sent the order is `create_unknown`,
never resent on its own, until a validated, correlated answer makes it
`placed`, which needs no shop credential to deliver and is final for a
download; a placed parcel is followed until it ships or the shop ends it. A
private command for one order, not a public route or SDK method, closes a
download's paid failures: a pre-create refusal may create once after the
merchant reconnects the same shop and the product still qualifies; an unknown
create binds only an order id the merchant supplies, read back and matched on
every fact of the sale. A mismatch stays unfulfilled, and so does a parcel's,
whose address is gone by then.

The merchant's Orders screen offers recovery for their own unfulfilled downloads.
The authenticated account must own the saved sale before its details are
disclosed or a gateway or shop call runs. The merchant supplies the exact
existing shop order ID, or retries a download already saved; this screen never
creates a shop order. A confirmed delivery ends the recovery, while an unknown
result keeps its saved binding visible for another read or retry. Parcels and
pre-create refusals have no recovery action here. The private maintenance
command retains its creation rule; no staffed recovery queue is part of the
service (the product owner, 2026-10-19).

## Consequences

The WooCommerce order carries the merchant's own email, since WooCommerce mails
whatever address is on it; whose address belongs there is an open product
question, and no buyer email is asked for. A card whose product changed or went
stays listed until the merchant pauses it; the price check refuses it before
payment, and a change after the quote leaves the order unfulfilled, as does a
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
error-prone (research 37); a time to ship stated per shop or none at all,
which the product owner put after the test; order lines carrying amounts
before tax we compute, which miss the price by a cent at two decimals; and a
price without an address for a download whose prices are entered before tax,
which would charge every buyer the tax of the shop's own city.
