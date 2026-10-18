# Selling through a WooCommerce shop

*The public contract is versioned; changes arrive in a new package version.*

You run a WooCommerce shop and want agents — programs buying on a person's
behalf — to buy from it without anybody writing code. The WooCommerce page of
your dashboard connects the shop, imports its products as cards, and from then
on the shop takes the paid orders. This page is what each of those steps does
to your shop, your cards and your money. The connector runs on the test
channel for now, where the money is not real.

## What can be imported

The connector imports a product only when it is a published simple product,
priced in US dollars, whose stock is not counted. The shop as a whole needs
WooCommerce's tax calculation turned off, prices written with two decimals
(WooCommerce → Settings → General → Number of decimals), and permalinks set to
anything other than Plain.

Such a product becomes one of two kinds of card:

| The product in your shop | What the agent gets | What your shop gets |
| --- | --- | --- |
| A virtual download with exactly one protected file, unlimited downloads and no expiry | the download, once it is paid for | a paid order |
| A physical product, neither virtual nor downloadable | a parcel: it pays the price plus your shop's cheapest shipping rate to the buyer's place | a paid order carrying the buyer's shipping address |

Every other product stays in your shop untouched, and the import names it with
the reason. A product also needs a name and a description in plain text,
because the description is what an agent reads before it decides to buy.

## Connecting your shop

You type the public https address at the root of your shop, and your browser
goes there next so that WooCommerce can ask you to approve access. Approve read
and write: with read alone, every purchase is refused before payment, because
Agentify cannot create the order in your shop. Agentify never asks for your
shop password.

Your shop sends the keys to Agentify in a request of its own, separate from
your browser coming back. The dashboard waits fifteen minutes for them. If none
arrive, it cannot tell whether you declined, closed the approval screen, or
the shop's request failed, and you press Connect again; where WooCommerce
showed an error, it has already removed the key from that attempt.

To revoke the keys in the shop yourself, open WooCommerce → Settings →
Advanced → REST API.

## Your shop or your code, one at a time

You sell through the shop or through your own code with the Agentify SDK, never
both. Pressing Connect switches you to the shop at once, before you approve:
the cards your code published go off sale and your code receives no orders
until you disconnect the shop.

The switch waits for the orders your code is still working on. Each has to
end first: delivered or refused by your code, paid or left unpaid by its
buyer, or closed when its time runs out. The dashboard names those orders, and
pausing all sales on Cards keeps new ones from arriving meanwhile.

If you pressed Connect and never approved, you sell through a shop that is not
connected, and nothing sells. The WooCommerce page offers the way back to your
own code; its cards come back with selling stopped until you resume it on
Cards.

## Importing

An import reads up to 200 products and publishes the ones the connector
supports. A shop with more than 200 products is refused whole rather than cut
short. Running the import again updates the same cards and does not double
them, and a card you paused stays paused through it.

Nothing is read until the name your products are sold under is set in
Settings, and the wallet your share is paid out to on a channel where payments
settle: without them every card would be refused.

The result lists every product it read under one of these headings:

| Heading | What happened | What you do |
| --- | --- | --- |
| Published | the product is one of your cards | nothing; whether it sells is on Cards |
| To fix | Agentify's publishing rules refused it, in the sentences shown | change what they name and import again; a length is counted with the markup removed, so your shop's editor shows a larger number |
| No verdict | Agentify did not answer about it, so whether it was published is not known | import again later |
| Not attempted | the import stopped at the first product with no verdict | import again later |
| Not imported | the connector could not make a card of it | the reason says what, if anything, can be changed in the shop |

## When a product changes in the shop

A product deleted from the shop, sold out, or no longer supported keeps its
card, but the price check refuses its purchase before payment, so no money
moves. Pause the cards you no longer want agents to see.

## Parcels

These rules decide whether you keep the money for a parcel.

1. Ship within seven days of payment and mark the order Completed in
   WooCommerce, in the shop it was sold from. The seven days are Agentify's
   number, because WooCommerce has no field for it.
2. An order not marked Completed within its seven days shows on your Orders
   screen as a refund you owe. Marking it Completed later, within thirty days
   of the order being placed, still clears that debt, unless a refund has
   already been recorded.
3. Completed tells the buyer the parcel has shipped, and it cannot be taken
   back. Where the order has a fulfilled WooCommerce fulfilment, the buyer gets
   its carrier and tracking; otherwise the buyer is told your shipping
   method's name as the carrier, with no tracking number.
4. An order you cancel or refund in WooCommerce has not shipped, and becomes a
   refund you owe when its seven days run out.
5. If Orders shows a refund owed before the seven days are up while your shop
   holds a paid order for it, do not ship that order: Agentify could not
   confirm it, and you owe the buyer a refund instead.
6. A parcel's card is published only once your shop's site is set in
   Settings, because the site is where a buyer asks about a parcel that did not
   arrive.

What a refund owed means for your money is on [Money](/money#if-the-buyer-did-not-get-the-goods).

## Disconnecting

Disconnecting removes the keys your shop gave Agentify and switches you back
to your own code. The shop's cards stay in your catalogue, off sale, and the
cards your code published come back with selling stopped until you resume it
on Cards.

The orders still waiting on the shop have to end first, because once it is
disconnected nothing reads the shop: a parcel ends when it is marked
Completed in WooCommerce, an unpaid purchase when its buyer pays or lets it
lapse, and any of them when its time runs out. A parcel already owed a refund
is no longer followed after you disconnect, so marking it Completed then does
not clear the debt.

Disconnecting does not revoke the keys inside your shop; that is done in
WooCommerce → Settings → Advanced → REST API.

## What is not settled yet

- Parcels on the live channel. A parcel sells on the test channel only until
  the refund of a lost parcel can be recorded, and selling it live will need
  the time to ship from you rather than Agentify's seven days.
- How a refund you owe goes back to the buyer. Agentify records the debt on
  your Orders screen; how the money travels back is open
  ([Money](/money#if-the-buyer-did-not-get-the-goods)).
