# Probe: what a WooCommerce shop with tax switched on does to the connector's prices and orders

Date: 2026-10-21. The questions, the shop, the requests, the predictions and the
decision rule below were fixed in this note and committed before the first
request reached the shop in a tax mode; the results follow in a section of
their own.

## Why this probe

The WooCommerce connector (ADR-0023) imports a shop's eligible products, quotes
an agent a fixed price in US dollars, and after the agent has paid creates one
paid order in the shop through `wc/v3/orders`. It matches that order to the
payment to the cent: the order's `total` must equal what was paid and its
`total_tax`, and the line's `total_tax`, must be `0.00`. A parcel's rate comes
from the shop's Store API cart for the buyer's locality, the way research 41
established, and a rate that carries tax is refused. To keep all of that true
the connector refuses any shop whose WooCommerce tax calculation is on
(`woocommerce_calc_taxes` must be `no`).

That setting belongs to the whole shop. A merchant who turns it off to connect
stops charging tax to every ordinary customer as well, so most shops that
charge tax cannot connect at all. The product owner asked whether such shops
can be supported and approved this probe to find out what WooCommerce actually
does with the connector's reads and orders when tax is on. The probe changes no
connector code. Its result is evidence for a later decision, which would be an
edit to ADR-0023 and is the product owner's to take.

Two families of shop matter, and they behave differently enough to be asked
about separately. In the first the merchant enters prices with tax already
inside them (`woocommerce_prices_include_tax = yes`). This is the usual way in
Indonesia and in Europe: the buyer pays the price on the label and the shop
splits the tax out of it. In the second the merchant enters prices before tax
(`= no`), as is usual in the United States, and tax is added on top according to
where the buyer is.

## The questions

The first question is what price the connector reads. The catalogue import
takes `prices.price` from the Store API's product listing, and the price check
before a sale takes `price` from the `wc/v3` product. Either could be the price
as entered, a price with tax added or removed for display, or a price that
depends on who is reading.

The second is what happens to the connector's order exactly as it is sent
today. Its line carries `subtotal` and `total` both set to the paid price, and
WooCommerce treats an order line's totals as amounts before tax. The probe
records the order's `total` and `total_tax`, the line's `subtotal`, `total` and
`total_tax`, the tax lines and the shipping line, and whether the total equals
what was paid.

The third is what order body would make the total equal the paid price with the
tax correctly recorded inside it, and whether that body is exact to the cent
across awkward prices under both of WooCommerce's rounding settings (rounding
tax per line, the default, or at the subtotal). Three bodies are tried beside
today's: a line that names the product and the quantity and leaves its totals
to WooCommerce, and lines whose totals are an amount before tax that the
connector would compute, written at two decimals and at six.

The fourth concerns inclusive prices and the buyer's location. When a buyer
sits outside the shop's base location, at a different rate or at none, does the
price stay the same or shift? WooCommerce's default here is a filter,
`woocommerce_adjust_non_base_location_prices`, which is on unless a merchant
adds code to turn it off, together with the "Calculate tax based on" setting
(the customer's shipping address, the default; the billing address; or the
shop's base address). The probe also asks which location a download's order is
taxed at, since the connector sends no address for one.

The fifth concerns exclusive prices and a parcel. Does the Store API cart, asked
for a locality the way the connector asks it, quote the same tax as the order
then created for an address in that locality? Is shipping taxed, and how does a
shipping rate's own tax status play into it?

The sixth concerns exclusive prices and a download. With no buyer address, what
tax does WooCommerce apply to the order, and is there any honest price the
connector could quote before payment?

## The shop

The shop is a throwaway copy of the integration lab (`deploy/woocommerce-lab/`)
built on a laptop with Docker by `56-woo-tax-probe/setup.sh` and
`56-woo-tax-probe/compose.yaml`. It runs the lab's images (`mariadb:11.4`,
`wordpress:7.1-php8.3-apache`, `wordpress:cli-php8.3`) and installs WooCommerce
the way the lab's baseline rebuild does, from the plugin directory's current
release: WordPress 7.1.3 and WooCommerce 11.2.1 on the day. It is seeded by the
lab's own `seed/store.php` and `seed/parcel.php`, then by
`56-woo-tax-probe/awkward.php`. It listens on a loopback port without TLS, and
the probe drives it through its REST API with a read/write key that the setup
script creates. WooCommerce accepts such a key over HTTP Basic only on HTTPS, so
every `wc/v3` request carries `X-Forwarded-Proto: https`, which the WordPress
image's own configuration treats as HTTPS. The administrator password and the
key are generated on each run, kept outside the repository and never committed.

The products are the lab's: the two downloads, Gift Message Templates at 1.00
(product 20) and Gift Wrapping Guide at 2 (product 21), and the tote bag
(product 22, 20.00). Eight more downloads are copies of the Gift Message
Templates product with the same file at prices whose tax does not divide
evenly: 0.99, 1.03, 1.06, 4.55, 9.99, 19.95, 33.33 and 99.99 (products 23 to 30).
Two of those, 1.03 and 1.06, were chosen because the arithmetic below says a
two-decimal ex-tax line misses them by a cent, so the probe can see a
one-cent error when there is one. The tote bag is re-priced through `wc/v3` to
20.00, 0.99, 19.95 and 33.33 for the parcel cases and put back at 20.00.

`56-woo-tax-probe/mode.php` puts the shop into a mode. Every mode leaves
WooCommerce's defaults alone except for what it names, and each sets the shop's
base address, the rates and the price entry. Display of prices (`woocommerce_tax_display_shop`
and `_cart`) is set to how a shop of that family shows them: with tax for the
two inclusive shops, without for the American one.

The Indonesian shop is based in Denpasar, Bali (`ID:BA`, 80361), with prices
entered including tax and one rate for Indonesia, PPN at 11%, applied to
shipping as well. Indonesia's VAT is 12% by law, but since 1 January 2025 it is
charged on a base of eleven twelfths of the price for ordinary goods (Minister
of Finance Regulation 131/2024), so a shop charges 11% of the price. Exports
are zero-rated, so no other country has a rate, and a buyer in San Francisco is
the "no rate" case. The lab's own zones price the parcels: the Bali courier at
3.00, Indonesia's Standard at 5.00 and Express at 12.00, and San Francisco at
7.50. The shop is tried once with those rates untaxed, as the lab seeds them,
and once with them taxable.

The German shop is based in Berlin (`DE:DE-BE`, 10115), with prices entered
including tax, German VAT at 19% (section 12 of the Umsatzsteuergesetz) and
French VAT at 20% (article 278 of the Code général des impôts) for a French
consumer, which is what a German shop past the EU's distance-selling threshold
charges through the One-Stop Shop, for downloads and for goods alike. Both rates
apply to shipping. The probe adds a zone for Germany at 4.90 and one for France
at 9.90, both taxable. A second pass installs, as a must-use plugin, the one
line that turns the location adjustment off
(`add_filter('woocommerce_adjust_non_base_location_prices', '__return_false')`),
which is how a merchant who wants one gross price for every buyer configures
WooCommerce.

The American shop is based in Seattle (`US:WA`, 98101), with prices entered
before tax and two stacked rates the way a Washington shop enters them by hand:
the state rate of 6.5% for all of Washington and Seattle's local 4.05% for the
postcodes 98101 to 98199, together 10.55%, the Department of Revenue's figures
for the fourth quarter of 2026. Washington taxes digital goods and delivery
charges, so both rates apply to shipping and the download is taxable. A seller
without nexus in another state has no other rate, so San Francisco is the
"no rate" case. The probe adds a zone for Seattle (the postcodes `981*`) at
6.00, taxable, and tries the parcels again with it untaxed.

Before this note was committed, the mode script was run once in each mode and
its effect read back through WP-CLI alone (the rate rows and the zones'
methods), and the probe's own functions were run with tax off to check its
mechanics, which made orders 42 to 52 in the shop. No Store API or `wc/v3`
request reached the shop while it was in a tax mode.

## The requests

`56-woo-tax-probe/probe.sh` (with `probe.py` building the bodies and printing
the answers) runs the probe in a fixed order and its output is
`56-woo-tax-probe/results.txt`. Every Store API exchange starts a new cart with
`GET /wp-json/wc/store/v1/cart`, sends its `Cart-Token` and no cookie or nonce,
adds the product with `POST /cart/add-item {"id": …, "quantity": 1}`, and for a
parcel places it with `POST /cart/update-customer` carrying only the shipping
locality (`country`, `state`, `city`, `postcode`, with an empty string for a
part the place does not have), as the connector does. A download's cart is read
back with `GET /cart` and no address.

Every order is `POST /wp-json/wc/v3/orders` with the connector's body:
`payment_method` and its title, a `transaction_id`, `set_paid: true`,
`currency: "USD"`, `billing: {email}` with a merchant's address and nothing
else, the correlation metadata and one line. The line differs by body. In B0,
today's body, it carries `subtotal` and `total` set to the paid price. In B1 it
carries only `product_id` and `quantity`. In B2a it carries `subtotal` and
`total` set to the price divided by one plus the base rate, rounded half up to
two decimals, and in B2b the same at six. A parcel's order adds the `shipping`
block with the locality and a placeholder name, street and phone, and one
`shipping_lines` entry for the cart's cheapest rate at its cost, as the
connector does. The location cases add a `billing` country, state, postcode and
city to a download's order.

The run, in order: tax off, one B0 order and one cart for product 20 as a
negative control. The Indonesian shop with untaxed rates: the price of
product 20 through `wc/v3` and the Store API, again with display without tax,
and again with a cart token placed in San Francisco; every download under B0,
B1, B2a and B2b and its cart, with tax rounded per line and then at the
subtotal; product 20 under B1 with no address and with a San Francisco billing
address under each of the three "based on" settings; the tote bag at its four
prices to Denpasar, Jakarta (`ID`, `JK`, 10110) and San Francisco (`US`, `CA`,
94105), each as a cart and as B0 and B1 orders. The Indonesian shop with taxable
rates: the parcels again. The German shop: the price reads with a token placed
in Paris (`FR`, 75001); the downloads as for Indonesia; the location cases with
a Paris billing address; the parcels to Berlin and Paris. The German shop with
one gross price: a Paris cart and price read, a B1 download with a Paris
billing address, the parcels to Paris. The Seattle shop: the price reads, also
with display including tax and with a token placed in San Francisco; the
downloads under B0 and B1 with their carts, per line and at the subtotal, B1
and carts at the subtotal; the location cases with a San Francisco billing
address; the parcels to Seattle (`US`, `WA`, 98101) and San Francisco with
taxable shipping, and to Seattle again untaxed. Last, tax off again.

## Predictions

Each prediction rests on reading WooCommerce 11.2.1's source. The numbers come
from `56-woo-tax-probe/predict.php`, which re-implements the arithmetic of an
order created through `wc/v3` (`calculate_totals`, `calculate_taxes` and
`update_taxes` in the abstract order, `WC_Tax::calc_tax`, and
`wc_get_price_excluding_tax` for a line posted without totals) and reads no
shop; its output is `56-woo-tax-probe/predictions.txt`. Run over every price
from 0.01 to 1000.00 at fifteen common rates, that arithmetic gives B1 the
exact gross price every time under both rounding settings, as does B2b, while
B2a misses by a cent for between a twentieth and a fifth of the prices, more
the higher the rate.

**P0, negative control.** With tax off, the B0 order for product 20 comes back
with `total` 1.00 and `total_tax` 0.00, and the cart quotes 1.00. Anything else
means the shop is not the lab's shop.

**P1, the price read.** The `wc/v3` product's `price` is the price as entered in
every mode, because it is the stored price with no tax function applied. The
Store API's `prices.price` is the stored price passed through
`wc_get_price_including_tax` or `wc_get_price_excluding_tax` according to the
display setting. It therefore equals the entered price whenever the display
matches the entry (the inclusive shops showing tax, the Seattle shop not), and
differs otherwise: the Indonesian shop shown without tax gives 0.90 for 1.00,
and the Seattle shop shown with tax gives 1.11.

**P2, the reader's location.** Neither price depends on who reads it. A Store
API product route does not load the cart or the session's customer, so the tax
functions fall back to the shop's base location even when a placed cart token
is sent: the Indonesian price read with a San Francisco token stays 1.00, the
German one with a Paris token 1.00, the Seattle one with display including tax
1.11. I am less sure of this than of the others, because it rests on which
requests initialise WooCommerce's customer object.

**P3, today's body.** WooCommerce takes B0's line total as an amount before tax
and adds tax on top wherever a rate applies, so no order with a rate equals
what was paid. In the inclusive shops at base the total is the price times one
plus the rate, rounded (1.11 for 1.00 in Indonesia, 1.19 in Germany; every
figure is in `predictions.txt`), the line comes back with `subtotal` and
`total` as sent and a positive `total_tax`, and there is one tax line, PPN or
MwSt. In the Seattle shop a download is taxed at the shop's base and comes back
at 1.11 for 1.00, with two tax lines, WA State and Seattle. A parcel adds the
rate's cost, and the rate's tax where the rate is taxable. Where no rate applies
(an Indonesian or Seattle parcel to San Francisco) B0 equals goods plus rate.

**P4, rounding.** In both inclusive shops, at the base location, B1 comes back
with `total` equal to the price for all ten prices, under both rounding
settings, with `total_tax` as in `predictions.txt` (0.10 for 1.00 in Indonesia,
0.16 in Germany) and the line's `total` showing the amount before tax. B2b does
the same. B2a misses by a cent at 1.06 in Indonesia (1.05) and at 1.03 (1.04),
9.99 (9.98), 19.95 (19.94) and 99.99 (100.00) in Germany. The reason B1 is
exact is that WooCommerce strips the tax from the gross at six decimals, rounds
the line half up and the tax half down in an inclusive shop, and the two
fractions always meet.

**P5, the inclusive download's quote.** The Store API cart for a download with
no address quotes `total_price` equal to the price and a `total_tax` equal to
that of the B1 order, for every price, because the cart works from the gross.

**P6, where a download is taxed.** An order with no address is taxed at the
shop's base under all three "based on" settings, because WooCommerce falls back
from the shipping address to the billing address to the base when a country is
missing: B1 is the price in the inclusive shops and the price plus Seattle's
tax in the American one. With a billing country, the "shipping" and "billing"
settings tax at that country and "base" ignores it: the German shop's 1.00 to
Paris comes to 1.01, the Indonesian shop's 1.00 to San Francisco to 0.90, the
Seattle shop's 1.00 to San Francisco to 1.00.

**P7, inclusive parcels.** For every locality, price and shipping tax status,
the cart's `total_price` equals the B1 order's total for the same locality,
because the cart's and the order's arithmetic move the gross price to the
destination's rate in the same way (an equality the simulation also found at
every price to 1000.00). The figures are those in `predictions.txt`: Denpasar
and Jakarta keep the gross price and add the rate (and its 11% when taxable);
San Francisco from the Indonesian shop gets the goods without Indonesian tax
(18.02 for 20.00) plus 7.50; Paris from the German shop gets the goods moved to
the French rate (16.81 + 3.36 for 20.00) plus 9.90 and its 1.98.

**P8, one gross price for every buyer.** With the adjustment filter off, the
Store API cart for Paris keeps the gross price of the goods (20.00 plus 9.90 and
1.98, so 31.88), but the B1 order to the same Paris address still strips German
tax and adds French tax (32.05), because an order made through `wc/v3` has no
customer for the filter's alternative to use and falls back to the base rates.
So the cart and the order disagree. The download to a Paris billing address
comes to 1.01 against the cart's 1.00.

**P9, exclusive parcels.** For Seattle and for San Francisco, for every price and
both shipping tax statuses, the cart's `total_price` equals the order's total,
and B0 and B1 come out alike because the entered price is already the amount
before tax. Seattle at 20.00 is 28.74 with taxable shipping (the goods' 2.11 of
tax and the rate's 0.63) and 28.11 untaxed; San Francisco is 27.50 with no tax.
A taxable Seattle rate shows non-zero `taxes` in the cart (0.63), and an untaxed
one shows zero. The connector's quote today, goods plus rate, falls short of
both Seattle totals.

**P10, exclusive downloads.** With no address the order is taxed at Seattle's
combined rate and the cart without an address quotes the same total, with each
rate rounded per line by default; the totals are in `predictions.txt`. At the
subtotal setting 19.95 comes to 22.05 instead of 22.06, in the cart and in the
order alike.

## Decision rule

Inclusive-price downloads are proposed for support if P4 holds for B1 at every
price in both inclusive shops under both rounding settings, P5 holds, and P6
shows an order without an address taxed at the base (B1 equal to the price). The
proposal is then: the order's line names the product and the quantity and no
totals (B1); the connector takes the order on when `total` equals what was paid
and records `total_tax` and the tax lines instead of requiring zero; a shop with
tax on is accepted only with prices entered including tax for this class; and
the price read keeps to `wc/v3` `price`, or the import reads the Store API only
if P1 shows it equal to the entered price under the shop's display setting,
otherwise the display setting is named at the door. If B1 misses the price by
a cent anywhere at the base, inclusive shops are not proposed with B1; if B2b is
then exact everywhere, B2b is described as possible only with the rate read
from the shop, and the proposal is left to the product owner; if neither is
exact, inclusive downloads are not supportable.

Inclusive-price parcels are proposed if P7 holds: the price quoted is the
cart's `total_price` for the locality rather than the product's price plus the
rate, and the order is B1 with the shipping line and the address. If P8 shows
the cart and the order disagreeing when the merchant keeps one gross price,
which the connector cannot see from outside, the proposal is narrowed to
localities whose cart taxes the goods at the same rates as the shop's base, and
every other locality is answered "not available" with words; if they agree,
the proposal is not narrowed. If the cart and the order disagree at the base
locality itself, inclusive parcels are not supportable.

Exclusive-price parcels are proposed if P9 holds at every price, locality and
shipping tax status: the quote is the cart's `total_price` for the locality,
goods, rate and tax together, and the order is today's body or B1 with the
shipping line and the address, taken on when its total equals what was paid.
If the cart and the order differ for an address in the locality the cart was
asked for, exclusive parcels are not supportable without the buyer's whole
address at the time of the quote, which an agent's price question does not
carry.

Exclusive-price downloads: if P10 holds, the connector could quote the cart's
total without an address, which is the shop's own location's tax. That is
proposed only as an option the product owner chooses between, because whether
a buyer elsewhere owes the seller's local tax is the merchant's legal question
and the agent's price would say nothing about it: either such shops sell
downloads at the base-location total, and the merchant documentation says so,
or the connector refuses the class with words. If the order without an address
carries no tax, or differs from the cart without an address, exclusive
downloads are not supportable without the buyer's address.

If the negative control fails, or a mode's read-back shows rates other than
those described above, the results are void and the probe is reported as such.
Shops with tax on are "not supportable at all" if B0, B1 and B2b all miss the
price at the base in an inclusive shop and the cart and the order disagree for
exclusive parcels at the same address.

## What the probe does not measure

Tax plugins that ask an outside service for the rate — WooCommerce Tax, TaxJar,
Avalara and their kind — replace WooCommerce's own rate tables and are not
measured; nothing here says what they do to the connector's orders. Neither are
tax classes other than the standard one (reduced or zero rates), compound rates,
coupons, a quantity above one, a customer marked exempt from VAT, more than one
currency, or a WooCommerce version other than 11.2.1. Whether a given tax
treatment is lawful for a merchant is not a question this probe can answer.
