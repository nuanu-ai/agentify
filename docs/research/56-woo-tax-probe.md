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

## Results

The probe ran on 2026-10-21 at 10:06 UTC against the shop described above,
WooCommerce 11.2.1, and its whole output is `56-woo-tax-probe/results.txt`. It
made orders 53 to 358, every one of them answered with an order, and no
request was refused. One follow-up was run by hand afterwards and is reported
as such below; its output is `56-woo-tax-probe/followup.txt`.

**P0 holds.** With tax off, the connector's body came back at 1.00 with
`total_tax` 0.00, and the cart quoted 1.00. The read-back of each mode named the
rates and the shipping tax status described above.

**P1 holds.** The `wc/v3` `price` was the entered price in every mode and every
read: 1.00 for product 20. The Store API's `prices.price` was 1.00 where the
display matched the entry, 0.90 in the Indonesian shop set to display without
tax, and 1.11 in the Seattle shop set to display with tax.

**P2 holds.** A cart token placed elsewhere did not move the Store API's
product price: 1.00 for the Indonesian shop with a San Francisco token, 1.00 for
the German shop with a Paris token (with and without the one-price filter), and
1.11 for the Seattle shop showing tax with a San Francisco token. The carts
those tokens belonged to did move: the Indonesian download placed in San
Francisco was quoted 0.90 with no tax, the German one placed in Paris 1.01.

**P3 holds.** Today's body never equalled what was paid wherever a rate
applied. In the Indonesian shop the ten downloads came to the predicted 1.11,
2.22, 1.10, 1.14, 1.18, 5.05, 11.09, 22.14, 37.00 and 110.99, in the German shop
to 1.19, 2.38, 1.18, 1.23, 1.26, 5.41, 11.89, 23.74, 39.66 and 118.99, each line
coming back with `subtotal` and `total` as sent and the tax added on top, with
one tax line (PPN or MwSt.). In the Seattle shop the download of 1.00 came to
1.11 with two tax lines, WA State 0.07 and Seattle 0.04. A parcel added the
rate and its tax: the tote bag at 20.00 to Denpasar came to 25.20 against the
23.00 the connector would quote today. Where no rate applied, the Indonesian and
the Seattle shops' parcels to San Francisco, today's body equalled goods plus
rate.

**P4 holds.** B1 came back equal to the price for all ten downloads in both
inclusive shops under both rounding settings, forty orders in all, with the
tax recorded inside the total and the line's `subtotal` and `total` showing the
amount before tax (0.90 and a `total_tax` of 0.10 for 1.00 in Indonesia; 0.84
and 0.16 in Germany). B2b did the same. B2a missed exactly where predicted: 1.05
for 1.06 in Indonesia, and 1.04 for 1.03, 9.98 for 9.99, 19.94 for 19.95 and
100.00 for 99.99 in Germany, under both rounding settings.

**P5 holds.** For all forty download carts in the inclusive shops, the cart's
`total_price` equalled the price and its `total_tax` equalled the B1 order's.

**P6 holds.** An order with no address was taxed at the shop's base under all
three "based on" settings: 1.00 with 0.10 of tax in Indonesia, 1.00 with 0.16
in Germany, 1.11 in Seattle. With a billing address, the "shipping" and
"billing" settings followed it (San Francisco from Indonesia 0.90 with no tax;
Paris from Germany 1.01 with 0.17; San Francisco from Seattle 1.00 with no tax)
and "base" did not.

**P7 holds.** In all forty parcel cases of the inclusive shops (Denpasar,
Jakarta and San Francisco from Indonesia with the shipping untaxed and taxable,
Berlin and Paris from Germany, four prices each) the B1 order's total equalled
the cart's `total_price`, at the predicted figures: for 20.00, 23.00 and 25.00
to Denpasar and Jakarta untaxed, 23.33 and 25.55 taxed, 25.52 to San Francisco
(the goods without Indonesian tax, 18.02, plus 7.50), 25.83 to Berlin, and 32.05
to Paris.

**P8 holds.** With the one-price filter installed, the Paris cart kept the gross
price of the goods (31.88 for 20.00; 12.87, 31.83 and 45.21 for the other three
prices), while the B1 orders to the same address came to 32.05, 12.88, 31.99 and
45.49, the figures without the filter. The download to a Paris billing address
came to 1.01 against the cart's 1.00.

**P9 holds.** For Seattle and San Francisco, every price and both shipping tax
statuses, the order's total equalled the cart's `total_price`, and today's body
and B1 came out alike: for 20.00, 28.74 to Seattle with taxable shipping (the
cart's rate showing `taxes` of 0.63), 28.11 with it untaxed, and 27.50 to San
Francisco with no tax. The connector's quote today, goods plus rate, would have
been 26.00 for Seattle.

**P10 fails.** Its order half held: with no address the download orders were
taxed at Seattle's combined rate, both rates rounded per line by default, at the
predicted totals (1.11, 2.21, 1.09, 1.14, 1.17, 5.03, 11.04, 22.06, 36.85 and
110.54), and at the subtotal setting 19.95 came to 22.05 as predicted. Its cart
half did not: the cart without an address quoted only the state rate, 1.07 for
1.00 and 21.25 for 19.95, never the order's total. The reason is in
WooCommerce's source and was missed in the reading before the run: a cart's
customer with no address starts from the shop's base country and state only
(`wc_get_customer_default_location`), without its postcode or city, so a rate
keyed by postcode, as Seattle's is, does not reach the cart, while an order
with no address falls back to the whole base address, postcode and city
included. A shop whose "Default customer location" is set to geolocation would
add a second difference, since the cart would then be located by the address
of whoever asks.

The follow-up, by hand and deciding nothing: the same cart placed with
`update-customer` at the shop's own locality (`US`, `WA`, Seattle, 98101)
quoted 1.11, 22.06 and 110.54 for 1.00, 19.95 and 99.99, the orders' totals.

## Reading against the decision rule

Inclusive-price downloads meet the rule: P4 holds for B1 everywhere, P5 holds
and P6 shows an order without an address taxed at the base. The proposal is
therefore the one the rule names. The order's line names the product and the
quantity and no totals, and WooCommerce computes the amount before tax from
the product's own price. The connector takes the order on when `total` equals
what was paid; `total_tax`, the line's `total_tax` and the tax lines are
recorded rather than required to be zero, and the line's `subtotal` and `total`
are no longer compared with the paid price, since they now hold the amount
before tax. A shop with tax on is accepted for this class only with prices
entered including tax. Because B1 takes the product's current price, a price
the merchant changed between the quote and the order shows as a total that
does not match, which the existing match already catches. On the price read,
P1 shows the Store API equal to the entered price only when the shop displays
prices with tax, so either the import keeps to `wc/v3`'s `price`, or a shop
whose catalogue display excludes tax is named at the door.

Inclusive-price parcels meet the rule for the narrowed proposal: P7 holds, so
the quote becomes the cart's `total_price` for the locality and the order B1
with the shipping line and the address; but P8 shows the cart and the order
disagreeing when a merchant keeps one gross price by a filter the connector
cannot see. Inclusive parcels are therefore proposed only to localities whose
cart taxes the goods at the same rates as the shop's base, and any other
locality is answered "not available" with words. In this probe that leaves
Denpasar and Jakarta for the Indonesian shop and Berlin for the German one, and
refuses San Francisco and Paris.

Exclusive-price parcels meet the rule: P9 holds at every price, locality and
shipping tax status. The proposal is to quote the cart's `total_price` for the
locality, goods, rate and tax together, to create the order with today's body
or B1 and the shipping line and the address, and to take it on when its total
equals what was paid. The connector's present refusal of a rate whose `taxes`
is not zero would go.

Exclusive-price downloads fall under the rule's last branch: the order without
an address differs from the cart without an address, so they are not
supportable without the buyer's address, and the connector keeps refusing them
with words. The follow-up shows that a cart placed at the shop's own locality
quotes exactly what the order without an address charges. That is a different
quote from the one the rule was written about, and whether to take it up is the
product owner's question; it would still charge every buyer the tax of the
shop's own city, which is the legal question the rule already put to the
merchant.

Nothing here met the "not supportable at all" branch, and nothing voided the
results.

## Teardown

The probe's containers and volumes were removed after the run with
`docker compose -p woo-tax-probe down -v`, and its images were left in place.

## After the implementation: half a cent on taxed shipping

This section is not part of the pre-registered probe. An adversarial review of
the connector built on the reading above found, on a rebuilt copy of the same
shop, a cart and an order that disagree at the shop's own address, which the
probe's shipping costs (4.90 and 9.90 at 19% and 20%; 3.00, 5.00 and 12.00 at
11%) never reached. In the German shop, prices including tax, the tote bag to
Berlin with the shipping cost set in turn to 0.50, 1.25, 1.50, 2.50, 3.33,
4.90, 7.50, 10.50 and 12.50, at the prices 20.00, 19.95 and 0.99, was priced
by the cart and then ordered with the line left to the shop and the cheapest
rate. With tax rounded per line, every cost whose 19% falls exactly on half a
cent (0.50, 1.50, 2.50, 7.50, 10.50, 12.50: 0.095, 0.285, 0.475, 1.425,
1.995, 2.375) gave an order one cent below the cart, at all three prices, and
every other cost gave the cart's total: the cart rounds that half cent up and
the order down. With tax rounded at the subtotal, all twenty-seven agreed.
The review also found the same at a single 5% rate on 4.90 and with two rates
of 10% and 5%, and found that the prices-before-tax shop agreed at every such
cost under both settings.

The same review found that a shop showing its tax as a single total gives
carts with no tax lines, so a comparison of tax lines alone cannot tell a
place taxed otherwise than the shop's own address; comparing the goods'
amount and tax in the two carts can.

A second round of the review then found a compound rate past the rule built
on that sweep, which refused a parcel only where the shipping cost times one
of the cart's rates fell exactly on half a cent. In the German shop with a
10% rate and a 5% compound one, rounding per line, the compound rate's tax on
3.00 of shipping is 5% of 3.30, 0.165: the cart quoted 23.47 at the shop's own
address and the order came to 23.46, and with 1.00 of shipping 21.16 against
21.15. The cart's tax lines do not say which rate is compound, so the
prediction cannot be made from them. Rounding at the subtotal, every case of
both rounds agreed: the same two compound cases, stacked rates of 10% and 5%,
a reduced rate on the shipping, shipping costs finer than a cent, and orders
whose whole tax fell on half a cent. The half-cent rule was therefore replaced:
a parcel from a shop whose prices hold their tax sells only where tax is
rounded at the subtotal. Downloads were unaffected throughout, as P4 found,
and the shop entering prices before tax agreed under both settings.

The rule did not hold for downloads either. In the outside run that followed,
the same German shop with the 10% rate and the 5% compound one, rounding per
line, was paid 1.00 for a download left to the shop to price and recorded an
order of 1.01 with 0.14 of tax; rounding at the subtotal it recorded 1.00, and
99.99 for the download at 99.99. P4 had measured single rates only. So the
rule became one for every sale from a shop with tax on, downloads and
parcels, prices entered with tax or before it: tax must be rounded at the
subtotal. A shop with tax off is not asked about the rounding. On the one-item
orders measured, switching a shop from rounding per line to rounding at the
subtotal moved an order's tax by a cent at most (21.78 to 21.79, 7.72 to
7.73, 22.06 to 22.05); orders of several lines were not measured.

A third and last round of the review, with tax rounded at the subtotal, found
two more ways for the cart and the order to part, both confirmed on the
rebuilt shop. A shipping cost entered finer than a cent, as a German shop
enters 10.0756 of net shipping so that customers see 11.99, is taxed exactly
by the cart and as the 10.08 the order is sent: paid 31.99, the order came to
32.00, and with prices entered before tax 35.79 against 35.80. And a shop
keeping one gross price by filter and showing its tax as a single total gave
carts with no tax lines, so at a small price, where 19% and 20% round to the
same cents, a Paris parcel paid at 12.98 was recorded at 12.99. The same round
found a false refusal: at 20% the cart rounds the goods before tax and their
tax each on its own, so a product at 1.11 shows 0.93 and 0.19 at the shop's
own address.

Across the three rounds there were five such cases, which are one class: the
order the connector creates through `wc/v3` and the Store API cart that
priced it compute shipping and tax with different arithmetic, and the cart's
answer does not show where they will part. Four of them, the half cent
rounded apart per line, the compound rate on a parcel, the compound-rate
download and the sub-cent shipping cost, were a cent apart. The fifth, one
gross price kept by filter behind a single tax total, moved a Paris parcel to
the French rate and came to 0.17 (31.88 against 32.05) in the first round,
and to a cent at the small price of the third.

The product owner decided on 2026-10-21 that a shop's order is taken on when
its total is what was paid or within one cent of it, either way, for every
shop, the difference recorded: on the shop's order, which carries what was
paid beside its own total, and in the connector's record of the sale, which
the merchant's Orders screen reads. Parcels from shops that calculate tax are
sold under the rules above, with the one cent also allowed between the cart's
goods and the price. An order further than a cent, such as the Paris case,
is still not taken on.

Two ways the review pointed to would close the class rather than bound it,
and are directions for later, not decisions: having the shop's own Store API
checkout build the order from the cart it priced, so the order is the cart's;
or creating the order unpaid and marking it paid only once its total matches,
so a mismatch never leaves a paid order in the shop.
