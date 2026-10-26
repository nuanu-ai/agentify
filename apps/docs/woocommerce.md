# Selling through a WooCommerce shop

You run a WooCommerce shop and want buyers — programs buying on a person's
behalf — to buy from it without anybody writing code. The WooCommerce page of
your dashboard connects the shop, imports its products, and from then on the
shop takes the paid orders. This page is what each of those steps does to your
shop, your products on Agentify and your money. The connector runs on the test
channel for now, where the money is not real.

## What can be imported

The connector imports a product only when it is a published simple product
that WooCommerce marks purchasable and in stock, whose stock is not counted and
which is not limited to one in an order (Sold individually). A shop priced in US
dollars sells at its own prices; a shop priced in another currency sells at a
rate you set, as [A shop priced in another currency](#a-shop-priced-in-another-currency)
describes. The shop's own settings have to allow it too, as
[Settings of your whole shop](#settings-of-your-whole-shop) describes.

Such a product is imported as one of two kinds:

| The product in your shop | What the buyer gets | What your shop gets |
| --- | --- | --- |
| A virtual download with exactly one protected file, unlimited downloads and no expiry | the download, once it is paid for | a paid order |
| A physical product, neither virtual nor downloadable | a parcel: it pays the price plus your shop's cheapest shipping rate to the buyer's place, and any tax your shop charges there | a paid order carrying the buyer's shipping address |

Every other product stays in your shop untouched, and the import names it with
the reason. A product also needs a name and a description in plain text,
because the description is what a buyer reads before it decides to buy.

At every purchase the connector asks your shop for the product's price, and
for a parcel the shipping rate, and your shop has four seconds to answer. A
shop slower than that loses that sale before any payment, and only the
connector's own log, which your dashboard does not show, records why.

The buyer gets a download through Agentify: once your shop has created the
order, the order the buyer reads from us carries your shop's private download
address for the file, the file's name and the order's number in your shop, and
the file itself comes from your shop at that address.

Each order is created in your shop with your own dashboard email as the
customer's, so the shop's customer emails — the confirmation, the download
link — come to you and never to the buyer, and the shop's reports name you as
the customer of every sale.

An order your shop totals at what the buyer paid, or within a cent of it, is
taken on: the order carries what the buyer paid among its Agentify lines
(`agentify_paid`), and your Orders screen shows the shop's total beside it
where the two differ, so your shop's books can differ by a cent from the
USDC you received for that sale. An order further from it is not taken on. In
a shop priced in another currency the same holds in that currency, with one of
its smallest written amounts, a rupiah where prices have no decimals, in place
of the cent.

## Settings of your whole shop

A few of the things the connector needs are settings of the whole shop rather
than of one product, so changing one to sell through Agentify changes it for
every customer of the shop, not only for Agentify's buyers. Most of them are
WooCommerce's or WordPress's defaults, and a shop that never changed them has
nothing to change; the import names any setting that stands in a product's
way, and where to find it. What a shop that calculates tax needs is in
[the next section](#shops-that-calculate-tax).

A shop priced in US dollars has to write its prices with two decimals
(WooCommerce → Settings → General → Number of decimals), which is WooCommerce's
default; a shop priced in another currency with no decimals or with two. That
setting is how many decimals every price in the shop is shown with, to every
customer.

Permalinks have to be anything other than Plain (Settings → Permalinks, in
WordPress), because a site with Plain permalinks does not serve the addresses
the connector reaches WooCommerce at, its approval screen among them. Plain is
WordPress's own default, so a shop may well still use it. Switching to another
structure changes the address of every page, post and product on the site,
from the form `?p=123` to the structure you choose. WordPress sends a visitor
who follows the old address of a page or a post on to its new one, but neither
WordPress nor WooCommerce does so for a product's old address, written
`?product=` and the product's name, so check where such a link now leads
before you count on links already shared, printed or found through a search
engine.

A download needs four settings under WooCommerce → Settings → Products →
Downloadable products to stand at WooCommerce's defaults: the file download
method set to Force downloads, redirect mode not allowed as a last resort,
Downloads require login off, and access granted to downloadable products after
payment. Together they keep the file behind its download link and hand it to a
buyer, who has no account in your shop, as soon as the order is paid. Each of
them applies to every downloadable product in the shop. Force downloads sends
every customer's files through your site itself and keeps their address
hidden, and WooCommerce warns that some servers deliver large files unreliably
that way. With redirect mode not allowed, a file the chosen method cannot
deliver is no longer handed to the customer by its open address, so that
download fails instead. With login not required, a registered customer's
download link works without signing in, as a guest customer's always does, for
whoever holds the link. Granting access after payment gives every customer
their files once an order is paid and Processing, rather than only once you
mark it Completed.

A parcel needs the shop's shipping switched on (WooCommerce → Settings →
General → Shipping location(s), anything but disabling shipping) and not forced
to the billing address (WooCommerce → Settings → Shipping → Shipping
destination), both WooCommerce's defaults. Switching shipping on brings it into
every customer's cart and checkout: a physical product then asks where it goes,
is charged the rates of your shipping zones, and can be ordered only to a place
one of your zones has a shipping method for. Moving the shipping destination
off "Force shipping to the customer billing address" lets every customer enter
a shipping address other than their billing one at checkout; the connector
needs it because an Agentify order carries the buyer's address as its
shipping address.

## Shops that calculate tax

Where WooCommerce calculates tax in your shop, nothing sells unless it rounds
tax at the subtotal (WooCommerce → Settings → Tax → "Round tax at subtotal
level, instead of rounding per line"), and the import leaves every product
in your shop otherwise. Rounding on each line, WooCommerce's default, a tax
that comes to exactly half a cent can be rounded up in your cart and down in
the order made for the sale, so the order would record a cent other than what
the buyer paid; rounding at the subtotal, the cart and the order agreed in
every case measured. Switching it on changes how WooCommerce rounds the tax
of every order your shop takes, not only Agentify's: on the one-item orders
measured the tax moved by a cent at most, as when a 20.00 parcel with 1.50 of
shipping at 19% came to 21.78 rounding per line and 21.79 at the subtotal,
and orders of several lines were not measured.

What sells then depends on how your prices are entered (WooCommerce →
Settings → Tax → Prices entered with tax):

| Your shop | A download | A parcel |
| --- | --- | --- |
| Tax calculation off | sells at its price, and the order carries no tax | sells at its price plus your cheapest shipping rate to the buyer's place |
| Prices entered with tax inside them | sells at its price, and the order records the tax inside it at the rate of your shop's own address | sells at what your shop's cart charges for the buyer's place, but only to a place your shop taxes at the same rates as its own address |
| Prices entered before tax | not imported | sells at what your shop's cart charges for the buyer's place: the goods, your cheapest shipping rate and the tax on both there |

A buyer of a download gives no address, so its order is created without one,
and WooCommerce then taxes it at your shop's own address. Where your prices
hold their tax, the buyer pays the price Agentify shows wherever they are, and
the order shows the tax of your own address inside that price. Where your
prices are entered before tax, the tax would be added for your own city on
every buyer's price, whoever and wherever the buyer is, so such a download is
left in your shop.

A parcel's price is asked of your shop's own cart for the buyer's place at
every purchase, so the buyer pays what your cart charges there at your
cheapest shipping rate, tax included, and the order your shop then records
charges the same. Where your
prices hold their tax, WooCommerce takes the tax of your own address out of
the price and adds the tax of the buyer's place. Code added to a shop can keep
one price for every buyer instead, and the connector cannot tell from outside
whether yours does; the cart then shows that one price while the order created
for the parcel still moves it to the buyer's rate. So a parcel from such a
shop sells only to a place your shop taxes at the same rates as its own
address, and a buyer elsewhere is told before paying that the parcel is not
available there. A parcel also needs tax to be calculated on the customer's
shipping address (Calculate tax based on), which is WooCommerce's default. A
shop that set it to the billing address or to the shop's own address and sets
it back taxes every shipped order by the place it goes to, so a customer whose
order goes somewhere taxed otherwise than that address pays the tax of where
it goes.
Its price question also asks your cart about your own address, within the same
four seconds.

The import also leaves in your shop every product of a shop whose catalogue
shows prices otherwise than they are entered (Display prices in the shop),
because the import reads the catalogue's price while a buyer pays the price
as entered. Changing that setting changes whether every visitor to your
catalogue sees its prices with tax or without it.

Tax calculated by an outside service, such as WooCommerce Tax, TaxJar or
Avalara, is not supported. The connector cannot see such a service from
outside, and nothing has measured what it does to an order made through the
connector. If the order your shop records then charges something other than
what the buyer paid, the connector does not take that order on: the sale ends
unfulfilled on your Orders screen, your shop holds a paid order you should not
fulfil, and you settle it by your own policy.

Each of these settings applies to your whole shop, so changing one to sell
through Agentify changes what every customer of the shop is charged. Whether a
sale owes tax, and whether the treatment above is the right one for your shop,
are yours to settle; this page does not answer them.

## Connecting your shop

You type the public https address at the root of your shop, and your browser
goes there next so that WooCommerce can ask you to approve access. Approve read
and write: with read alone, every purchase is refused before payment, because
Agentify cannot create the order in your shop. Agentify never asks for your
shop password.

Before your browser leaves for the shop, Agentify reads one product from your
shop's public catalogue to learn the currency it is priced in and the decimals
it writes. A shop priced in another currency than US dollars is refused there,
before you approve anything and with nothing changed in how you sell, when its
prices are written with any number of decimals other than none or two, or when
Coinbase gives no rate for its currency. When Coinbase does not answer, Connect
stops and asks you to press it again in a moment. When the catalogue gives no
clear answer, because the shop has no products yet or does not serve its public
catalogue, Connect goes ahead and the import names each product it cannot sell.

Every request the connector makes to your shop names itself with the User-Agent
`Agentify/1 (+https://agentify.ad)`, so if a firewall or security plugin in
front of your shop blocks visitors it does not recognise, let that one through:
a shop that refuses it cannot be connected, imported or sold from. A paid
download is fetched from your shop's private download address by the buyer,
not by Agentify, so that address has to stay open to any visitor.

Your shop sends the keys to Agentify in a request of its own, separate from
your browser coming back. The dashboard waits fifteen minutes for them. If none
arrive, it cannot tell whether you declined, closed the approval screen, or
the shop's request failed, and you press Connect again; where WooCommerce
showed an error, it has already removed the key from that attempt.

Your account is connected to one shop at a time. Connecting the same shop again
renews its keys. To connect a different shop, [disconnect](#disconnecting) the
one that is connected first, which waits for the orders still waiting on it to
end. A shop is known by its address, so a shop that has moved to a new address
counts as a different shop.

To revoke the keys in the shop yourself, open WooCommerce → Settings →
Advanced → REST API.

The connector works on up to four stream messages at once for your shop, so
one slow order creation need not delay the next purchase or price question.
If all four are busy, later questions wait and may expire. A repeat of an
order already being created shares that attempt; the connector's durable
record still prevents a second shop creation after a restart.

## A shop priced in another currency

A shop priced in another currency than US dollars, such as rupiah, sells at an
exchange rate you set on the WooCommerce page of your dashboard: how many units
of your currency one US dollar buys, written in digits, such as 18000 for
eighteen thousand rupiah, with a dot only before a fraction and nothing between
thousands. The currency is your shop's own setting, read from the shop; you do
not choose it, and a shop priced in US dollars is asked for no rate. Nothing
from such a shop is published until you set one, and saving a rate imports
your products again, so they are listed at prices in dollars at it.

A buyer pays in US dollars, as USDC: your shop's price, or for a parcel your
cart's total, divided by your rate and rounded up to the next cent, so, for
example, a product priced Rp 240.000 at 18000 rupiah to the dollar sells for
13.34 USD.
The buyer is told the dollar price and nothing about your rate. Agentify takes
no currency margin, and its {{commission}} commission is of the USDC paid. What that USDC
is worth in your currency when you sell it depends on your exchange and its
spread, which your rate should allow for.

Beside the field the page shows Coinbase's open rate, with the moment Agentify
read it, because Coinbase's answer carries no time of its own. It is there to
catch a mistyped rate and decides no price. A rate more than a tenth away from
it is saved only once you type it a second time, and the page shows what a
product of yours would then cost in dollars: the first of the first ten in your
shop's public catalogue with a price, or, where none of them has one, says so.
A rate written the wrong way round, or with a digit missing, is the mistake
this catches. When Coinbase does not
answer, the rate is saved all the same, with a note that it was not compared
with anything. Every rate saved is sent to your account's email address with
the rate before it and when the session that saved it signed in, and a rate whose message could not be sent is not saved,
because a rate nobody was told of could sell your goods for cents unseen.
Every rate you have saved is kept.

Your rate keeps selling until you change it, however old it is, and also after
you disconnect the shop and connect it again: the page shows when it was
entered, when the session that saved it signed in, and how far it now stands
from Coinbase's, and keeping it current is yours. Neither the page nor the
message names an address as who entered the rate, because every session of
your account carries your address, a session somebody copied from your browser
included; for the same reason a sign-in moment you recognise does not prove it
was you. Where the moment that session signed in is not recorded, the page
says so rather than name one. A price a buyer was given holds at the rate it was given at,
even if you change the rate before the order reaches your shop, because the
buyer has paid by then. If your shop's currency changes, every purchase is
refused before payment until you set a rate for the new one; a rate set for
the old currency is never applied to it. Should the shop change back to a
currency you set a rate for before, the last rate you set for it applies again.

Your shop's order is made in your currency at your own price, and its Agentify
lines carry what the buyer paid in USDC (`agentify_paid`), the amount it was
priced at in your currency (`agentify_shop_amount`) and the rate with the
moment you set it (`agentify_rate`). Your Orders screen shows the same for the
sale, for example "240000 IDR in your shop, paid as 13.34 USDC at your rate of
18000 IDR per US dollar".

## Your shop or your code, one at a time

You sell through the shop or through your own code with the Agentify SDK, never
both. You move to the shop when it sends Agentify its keys, which it does the
moment you approve access: from then the products your code published are off
sale and your code receives no orders until you disconnect the shop. The
WooCommerce page says how many products that takes off sale before you press
Connect. Until the keys arrive nothing changes, so if you decline or close the
approval screen, your code goes on selling as before. Keys that grant less than
Read/Write switch nothing either, because every purchase through them would be
refused; the page asks you to connect again and approve Read/Write.

Connect and Sell through this shop are refused while an order from your code
is still open, and each such order has to end first. A purchase its buyer has
not paid yet ends within a minute, paid or lapsed, so the page asks you to try
again then. An order your code took on ends when your code delivers or refuses
it, or when its time runs out; the page names those orders and links to them on
Orders. If you paused all sales on Products to keep new orders from arriving
meanwhile, selling stays paused after the switch until you resume it there.

An order from your code can also open while you are approving. The shop is then
connected when its keys arrive, but you keep selling through your code, and the
WooCommerce page offers Sell through this shop to press once that order has
ended.

If you sell through the shop while none is connected, nothing sells. The
WooCommerce page offers the way back to your own code; its products come back
with selling stopped until you resume it on Products.

## Importing

An import reads up to 2,000 products and publishes the ones the connector
supports. A shop with more than 2,000 products is refused whole rather than cut
short. Running the import again updates the products it published before and
does not double them, and a product you paused stays paused through it.

The page answers once every product has been read and published, so a large
shop takes a while: the import asks your shop for a hundred products at a time,
a few requests at once, and how long that takes depends on how quickly your
shop answers. If you leave the page, the import carries on and the products it
publishes appear on Products, but its list of what was published and what was
not shows only on the page that started it. One import of a shop runs at a
time; pressing Import again while one runs reads nothing and says so. A shop
that reports more than 2,000 products is refused on the first page it
answers.

Nothing is read until the name your products are sold under is set in
Settings, and the wallet your share is paid out to on a channel where payments
settle: without them every product would be refused, so Import stays unavailable
and says which of them to set. A shop priced in another currency imports
nothing until its rate is set, which the page asks for first.

The result lists every product it read under one of these headings, in this
order:

| Heading | What happened | What you do |
| --- | --- | --- |
| To fix | Agentify's publishing rules refused it, in the sentences shown, or the connector left it for something the shop can change, such as a product not published or a download limit | change what they name and import again; a length is counted with the formatting removed, so your shop's editor shows a larger number |
| No verdict | Agentify did not answer about it, so whether it was published is not known | import again; it does not double products |
| Not attempted | the import stopped at the first product with no verdict | import again |
| Not supported | the connector does not sell its kind, such as a variable or grouped product, a product with stock tracking, or a download that also ships | nothing in Agentify; the connector does not take the product as it is |
| Published | the product is on Products, folded under the other headings | nothing; whether it sells is on Products |

## When a product changes in the shop

A product deleted from the shop, sold out, or no longer supported stays on
Products, but the price check refuses its purchase before payment. Pause the
products you no longer want buyers to see. A change that lands after a buyer was quoted
and before the order is placed, such as a new price, or for a parcel a
different shipping rate, leaves that paid sale unfulfilled on your Orders
screen, because the connector checks the product and the rate again before it
creates the order and refuses what no longer matches what was paid.

## Parcels

These rules describe what Agentify records about a parcel. Whether it arrives,
and what you do for the buyer if it does not, are yours and your shop's.

1. Ship within seven days of payment and mark the order Completed in
   WooCommerce, in the shop it was sold from. The seven days are Agentify's
   number, because WooCommerce has no field for it.
2. An order not marked Completed within its seven days shows on your Orders
   screen as unfulfilled. Marking it Completed later, within thirty days of the
   order being placed, still records the shipment, unless you have closed
   fulfillment of it.
3. Completed tells the buyer the parcel has shipped, and it cannot be taken
   back. Where the order has a fulfilled WooCommerce fulfilment, the buyer gets
   its carrier and tracking; otherwise the buyer is told your shipping
   method's name as the carrier, with no tracking number.
4. An order you cancel or refund in WooCommerce has not shipped, and shows as
   unfulfilled when its seven days run out.
5. If Orders shows an order as unfulfilled before its seven days are up while
   your shop holds a paid order for it, do not ship that order: Agentify could
   not confirm it with your shop. Close fulfillment of it on Orders with an
   explanation for the buyer, and settle the shop order by your own policy.
6. A parcel is published only once your shop's site is set in
   Settings, because the site is where a buyer asks about a parcel that did not
   arrive.

To stop Agentify accepting delivery for an order, use **Orders → Order details
→ Close fulfillment** ([what closing does](/money#if-the-buyer-did-not-get-the-goods)).
It changes nothing in your shop — no setting, no cancellation, no refund — so
stop the shop's own work on that order yourself. Your explanation, if you give
one, is shown to the buyer as your words.

## Recovering a download

If a paid download was not delivered and the connector has a saved sale it can
check, your Orders screen offers **Recover WooCommerce delivery** on that
order. The recovery page shows the Agentify order ID, the product, the amount
and the shop the sale came from.

When the connector refused a download before it sent anything to your shop,
your shop holds no order for it. This happens, for example, when the shop did
not answer the product check at the time of the sale, or when the product had
changed since its price was given. Connect the same shop again on the WooCommerce page, put
the product back the way it was sold if it changed, and press **Create shop
order** on the recovery page. Agentify then makes the order in your shop once,
at the price the buyer paid, and delivers the download when the shop places
it. If the shop refuses before anything is sent, the page says why, and you can
press again once that is fixed. If the shop's answer to the create does not
arrive, nobody knows whether the order exists, so the page never offers the
create again: find the order in your shop and link it, as described next.

When the shop's answer to creating the order never arrived, find the order in
that same shop whose Transaction ID is this Agentify order ID, and enter its
**Shop order ID**: the internal number in the order's address in WooCommerce,
after `id=` or `post=`, which can differ from the order number customers see.
**Link and deliver** checks that exact order and product against the saved
sale, then delivers the download; it does not search for another order or
create one. If your shop
holds no order with that Transaction ID, nothing can be delivered from this
page: close fulfillment on Orders with an explanation for the buyer.

When the shop order and its download are already saved, **Retry delivery**
sends that same download to Agentify, even after you disconnect the shop or
switch to your own code. If an answer was lost, the page offers a reload in
place of the button: it shows the saved order and says whether Agentify
confirms the delivery. A check that could
not be made leaves the result unknown, which is not proof that nothing was
recorded, and a saved order cannot be replaced by a different one.

Recovery makes or links the download's one shop order and delivers the
download, and does nothing else. To stop delivery instead, close fulfillment on
Orders; a closed order has no recovery action, and neither has a parcel. A
parcel refused before its shop order was made cannot be made later, because
Agentify does not keep its delivery address.

## Disconnecting

Disconnecting removes the keys your shop gave Agentify and switches you back
to your own code. The shop's products stay on Products, off sale, and the
products your code published come back with selling stopped until you resume
it there.

The orders still waiting on the shop have to end first, because once it is
disconnected nothing reads the shop: a parcel ends when it is marked
Completed in WooCommerce, an unpaid purchase when its buyer pays or lets it
lapse, any of them when its time runs out, and a paid one when you close
fulfillment of it on Orders. A parcel
already unfulfilled is no longer followed after you disconnect, so marking it
Completed then records no shipment in Agentify.

Disconnecting does not revoke the keys inside your shop; that is done in
WooCommerce → Settings → Advanced → REST API.

## What is not settled yet

- Parcels on the live channel. A parcel sells on the test channel only, and
  how a live parcel's time to ship is set is not decided.
- How a buyer reaches your support to arrange a remedy outside Agentify.
- Whether a merchant in Indonesia may accept USDC through Agentify for goods
  priced in rupiah, given the country's Currency Law; Agentify has not settled
  it, and whether a sale is lawful where your shop is remains yours to judge.
- Downloads from a shop whose prices are entered before tax, which would need
  the buyer's address at the moment the price is asked; parcels from a shop
  whose prices hold their tax to a place taxed otherwise than the shop's own
  address; and tax calculated by an outside service. See
  [Shops that calculate tax](#shops-that-calculate-tax).
