# 0036. A merchant sells through one integration at a time

Date: 2026-10-11
Status: accepted (the product owner chose one integration per merchant over
routing on 2026-10-11, a paused return to the SDK on 2026-10-12, and the switch
on the shop's keys on 2026-10-26)

## Context

A merchant's orders reach their worker through one stream (ADR-0010), and
whatever draws it receives all of them. On 2026-10-10 a merchant with a
connected WooCommerce shop (ADR-0023) also ran an SDK worker, which drew a
paid order for an imported product the shop never received; the connector
likewise refuses an order for a card the code published. Routing each order to
the integration that published its card puts that integration on every card
and order, adds a second stream per merchant, still lists a product sold both
ways twice and lets the code answer an order the shop is filling. Nobody sells
both ways today.

## Decision

A merchant sells through one integration at a time: their own code through the
SDK, or one connected WooCommerce shop. The gateway records which, and on
every card whether the import or the API published it. A card of the
integration not in use is off sale the way a paused card is, left out of the
catalog and refused before any payment, while its own pause flag stays as the
merchant set it.

Connect only asks whether the switch would be made now, so a refusal is said
beside the button and nobody is sent to the shop. The switch is made when the
shop's keys arrive granting read and write, because an approval abandoned at
the shop, or keys every purchase would be refused through, must not take the
code's cards off sale. A switch refused then leaves the shop connected and the
code selling, tells the shop's server nothing, and the shop screen offers the
switch again. Disconnecting switches back to the SDK, and leaves selling
paused where the code's cards come back on sale: an asynchronous order is paid
before the code answers, and the code may not be running. A Disconnect and
keys arriving in the same moment can leave the merchant on a shop with none
connected; the shop screen's way back is the exit.

A switch is refused, naming the orders, while one still waits on the
integration being left: to be paid at its quoted price, for its first answer,
or for its goods, a parcel until it ships, since the connector follows a
parcel only while its shop is connected. An order that owes only money holds
nothing. The switch and the making of an order wait for each other on the
merchant, and a poll held open across the switch returns empty. While the
merchant sells through the shop, the SDK's poll and publish are refused as not
retryable, naming the shop and the way back; the import is refused the same
way while they sell through their code. The merchant's keys still read orders
and receipts and deliver an order the code had already taken on.

The rule is the same on every channel, since every channel offers the
connector (ADR-0023). Cards already published are recorded by their merchant
item id, whose `woo_` shape only the import produces, and a merchant with an
imported card starts on the shop; the shop screen offers the way back to the
SDK whenever a merchant sells through the shop, connected or not.

## Consequences

A merchant cannot sell imported products and products from their own code at
once; the Connect screen says so before anything changes, and the Products
screen says it beside every product that is off sale for this reason. ADR-0023 no longer
calls the connector experimental (the product owner, 2026-10-11), and the
connector is offered on the live channel as a production option (the product
owner, 2026-10-26). The contract and the SDK do not change.

Rejected: routing by the publishing integration, for the cost and the gaps
above; switching at Connect, which takes the code's cards off sale for an
approval that may never come; refusing a second integration with no way to
switch, which strands a merchant who started on the SDK; switching cards off
with their own pause flag, which would put a card the merchant paused back on
sale on the way back; deleting them, which orders still name.
