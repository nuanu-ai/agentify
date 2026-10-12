# 0036. A merchant sells through one integration at a time

Date: 2026-10-11
Status: accepted (the product owner chose one integration per merchant over
routing on 2026-10-11, and a paused return to the SDK on 2026-10-12)

## Context

A merchant's orders reach their worker through one stream of their own
(ADR-0010), and whatever draws that stream receives every order of that
merchant. A merchant can publish cards from their own code through the SDK,
and can also connect a WooCommerce shop whose products the dashboard imports
and whose orders the dashboard's connector fills (ADR-0023). Nothing records
which of the two a card came from. In the second manual run, on 2026-10-10, a
merchant with a connected shop also ran an SDK worker, which drew a paid order
for an imported product, and the shop never received it. The other direction
fails as well: the connector refuses an order for a card the code published,
as a product it cannot fill.

Routing each order to the integration that published its card puts that
integration on every card and order, adds a second stream per merchant and
migrates both, and it still lists a product sold both ways twice and lets the
code answer an order the shop is filling. Nobody sells both ways today.

## Decision

A merchant sells through one integration at a time: their own code through
the SDK, or one connected WooCommerce shop. The gateway records which, and
records on every card whether the import or the API published it. A card of
the integration not in use is off sale the way a paused card is: left out of
the catalog, refusing a price question and an order before any payment, while
its own pause flag stays as the merchant set it, so switching back returns
exactly the cards that were on sale.

Pressing Connect switches the merchant to the shop before they are sent to
it, so a refusal is said beside the button rather than to a shop's server, and
disconnecting switches them back to the SDK. A switch is refused, in words
that name the orders, while an order still waits on the integration being
left: to be paid at the price it was quoted, for its first answer, or for the
goods it was taken on for, a parcel until it ships, because the connector
follows a parcel only while its shop is connected. An order that owes only
money holds nothing. The switch and the making of an order wait for each
other on the merchant, and a poll held open across the switch returns empty.

While the merchant sells through the shop, the SDK's poll and publish are
refused as not retryable, in words that name the shop and say that
disconnecting it in the dashboard brings the code's cards back; the import is
refused the same way while they sell through their code. The merchant's keys still read orders
and receipts and still deliver an order the code had already taken on.
Disconnecting a shop when the code's cards would come back on sale leaves the
merchant's selling paused until they start it again: an asynchronous order is
paid before the code answers, and the code may not be running.

The live channel offers no connector (ADR-0023), so every merchant there sells
through the SDK, and a connection made there earlier switches nothing. Cards
already published are recorded by their merchant item id, whose `woo_` shape
only the import produces, and a merchant with an imported card starts on the
shop; the shop screen offers the way back to the SDK whenever a merchant sells
through the shop, connected or not.

## Consequences

A merchant cannot sell imported products and products from their own code at
once; the Connect screen says so before anything changes, and the Cards screen
says it beside every card that is off sale for this reason. ADR-0023 no longer
calls the connector experimental (the product owner, 2026-10-11); it stays off
the live channel until its orders pass end to end on the test channel. The
contract and the SDK do not change.

Rejected: routing by the publishing integration, for the cost and the two gaps
above; refusing a second integration with no way to switch, which strands a
merchant who started on the SDK; switching the other integration's cards off
with their own pause flag, which would put a card the merchant paused back on
sale on the way back; deleting them, which orders still name and the way back
would have to publish again.
