# Probe: a shipping rate from a WooCommerce shop's cart, with no browser

Date: 2026-10-09. Predictions and the decision rule were fixed in this note and
committed before the probe ran; the results follow in a section of their own.

## Why this probe

ADR-0032 gives a merchant's price check the locality of a parcel's address —
the country, the state, the city and the postal code — and asks the merchant
for the whole price, shipping included. For a WooCommerce shop the connector
answers that question, and the product owner decided on 2026-10-09 that the
shipping part comes from WooCommerce itself: the shop's own rate for that
locality, the cheapest where it offers several, and no price at all where it
offers none, because the shop does not ship there.

WooCommerce has no REST endpoint that calculates a rate. Research 37
(`37-physical-goods.md`, § WooCommerce) read from WooCommerce's source that a
client without a browser can get one through the Store API's cart: read the
cart for a `Cart-Token`, add the product, set the customer's shipping address,
and read `shipping_rates` from the answer. It read that a cart token stands in
for the nonce a browser would send, and it never ran any of it. The whole
approach rests on that reading, so it is tried before any code is written.

## The shop

`woo.nuanu.ai`, the test shop the lab keeps (`deploy/woocommerce-lab/`),
running WooCommerce 11.1.0. On 2026-10-09 it was given one physical product and
three shipping zones by `deploy/woocommerce-lab/seed/parcel.php`:

- product 28, "Nuanu Tote Bag", a simple product at 20.00 USD, neither virtual
  nor downloadable;
- the zone "Bali", keyed by the state `ID:BA`, with the flat rate "Bali
  courier" at 3.00 (method instance 1);
- the zone "San Francisco", keyed by the country `US` and the postcode pattern
  `941*`, with "Standard" at 7.50 (instance 2);
- the zone "Indonesia", keyed by the country `ID`, with "Standard" at 5.00
  (instance 3) and "Express" at 12.00 (instance 4).

The zones are matched in that order and the first match wins. Every other
place falls to WooCommerce's zone for locations not covered, which has no
rate. The shop's currency is USD at two decimals, tax calculation is off,
shipping goes to every country it sells to, and the shipping address is not
forced to the billing address.

One observation was made before this note was written, while the shop's state
was being read: a plain `GET /wp-json/wc/store/v1/cart` answered 200 with a
`Cart-Token` header and a `Nonce` header. That is the first half of P1 seen
before it was predicted, and it is said here rather than counted as a
prediction that held.

## Predictions

Every exchange below starts with a new cart, sends no cookie and no `Nonce`
header, and sends the cart token it was given as `Cart-Token` on every call
after the first. The address sent is only the four fields of the locality.

**P1.** `GET /wp-json/wc/store/v1/cart` answers with a `Cart-Token` header.
With that token and no nonce, `POST /wp-json/wc/store/v1/cart/add-item` with
`{"id": 28, "quantity": 1}` answers 2xx with the product in the cart.

**P2.** `POST /wp-json/wc/store/v1/cart/update-customer` with only
`shipping_address: {country, state, city, postcode}` answers 2xx with
`needs_shipping: true` and `shipping_rates` holding the zone's flat rates. Each
rate carries its price in minor units with `currency_minor_unit: 2` and
`currency_code: "USD"`, and names a `method_id` and an `instance_id`. Four
localities, one per way a zone is matched:

| Locality | Expected rates |
| --- | --- |
| ID, BA, Denpasar, 80361 | `flat_rate` instance 1 at 300, and nothing else |
| ID, JK, Jakarta, 10110 | `flat_rate` instance 3 at 500 and instance 4 at 1200 |
| US, CA, San Francisco, 94105 | `flat_rate` instance 2 at 750 |
| US, NY, New York, 10001 | none: the postcode is outside `941*` |

The Bali row holding only the Bali rate is what shows that the state reaches
the zone matcher; the San Francisco and New York rows show the same for the
postcode.

**P3.** A country outside every zone — DE, no state, Berlin, 10115 — answers
2xx with no rate, and that answer is told apart from an error: an error is a
non-2xx answer carrying a `code`, which a request for a product that does not
exist (`id` 999999) is expected to produce.

**P4.** A record rather than a test: what each exchange leaves in the shop.
The rows of `wp_woocommerce_sessions` are counted before and after, and the
new rows' expiry and whether they hold the locality are read.

**Negative control.** Product 12, a virtual gift card, put in a cart and given
the Jakarta locality answers `needs_shipping: false` and no rate. If it got a
rate, the probe would be measuring something other than shipping.

The time each call takes is recorded beside the answers. The connector has to
finish the exchange inside the gateway's five seconds for a price answer
(`QUOTE_RESPONSE_MS`), so a probe that passes everything above in twelve
seconds would still be a finding.

## Decision rule

If P1, P2 and P3 hold, the connector prices a parcel through the cart.

If P1 fails because a nonce is required, or P2 returns rates only once more
than the four fields of the locality are sent, or P3's "no rate" cannot be
told apart from an error, nothing is built and the product owner is told.
The fallbacks are reading the zones through `wc/v3` and matching them with a
matcher of our own, which research 37 calls error-prone, or a different
decision. Where P2 fails, the probe repeats the failing case with a whole
address (a name, a first line and a phone added) only to tell "needs the whole
address" from "no rate at all"; that repeat decides nothing by itself.

If the negative control gets a rate, the probe's results are void and the
product owner is told.

The script is `41-woo-parcel-probe/probe.sh`; its output is
`41-woo-parcel-probe/results.txt`.

## Results

The probe ran on 2026-10-09 at 14:54 UTC from a laptop outside the shop's
network; its output is `41-woo-parcel-probe/results.txt`. Two follow-ups ran
by hand afterwards and are reported as such below.

**P1 holds.** Every `GET /cart` answered 200 with a `Cart-Token`, and every
`add-item` sent with that token and no nonce answered 201 with the product in
the cart.

**P2 holds.** Each locality got exactly the rates predicted: Bali only the
Bali courier at 300, Jakarta the two Indonesian rates at 500 and 1200, San
Francisco 750, and New York none. Every rate carried `method_id: "flat_rate"`,
its `instance_id`, `currency_code: "USD"`, `currency_minor_unit: 2` and
`taxes: "0"`. The four fields of the locality were enough: a zone keyed by a
state and a zone keyed by a postcode both matched on them, and no name, street
or phone was sent.

**P3 did not hold as written.** The Berlin request, which left `state` out,
was answered 400 `rest_invalid_param`: "The provided state (CA) is not valid.
Must be one of: DE-BW, … DE-BE, …". Two things are behind it, and both were
found by hand after the run.

The first is that a field left out of `update-customer` is not cleared. The
cart's customer starts from the shop's own base location, `US:CA` on this
shop, so a German address without a state was checked as a German address in
California. Sent with `"state": ""`, the same locality answered 200 with an
empty rate list, as P3 predicted. France and Singapore, sent the same way,
answered the same.

The second is that WooCommerce does not write every state the way ADR-0032
does. ADR-0032 takes a subdivision code without the country in front, one to
three capitals or digits: `BA`, `CA`, `BE`. WooCommerce 11.1.0 keeps states
for 69 countries. For 32 of them every code is of that shape, Indonesia and
the United States among them. For 23 every code carries the country and a
hyphen in front, `DE-BE` for Berlin, and Germany, Thailand, Bulgaria, Colombia
and Bangladesh are among them. For the other 14 some or all of the codes have
other shapes: the country and the number run together (`JP13`, `TR34`,
`KE01`, `UA05`), numbers of WooCommerce's own for China (`CN10`), lower case
for Morocco, and district names for Hong Kong. Sent `BE` for a German address,
the shop refused it, as it had refused `CA`; sent `DE-BE`, it answered 200.

What P3 was there to settle does hold: a locality the shop does not ship to is
a 2xx answer with an empty rate list (New York; Berlin, France and Singapore
with every field sent), and an error is a 4xx answer with a `code` — the
product that does not exist was `woocommerce_rest_cart_invalid_product`, and
the refused state `rest_invalid_param`.

**P4.** The shop's session table was empty before the run, so the plain
`GET /cart` made while the shop was being read left no row. Afterwards it held
seven rows, one for each cart that had held a product, each expiring 48 hours
after it was written. A row holds the customer's locality as it was sent (the
Bali row carries "Denpasar" and "80361"), and the name fields of the customer,
empty.

**Negative control.** The virtual gift card answered `needs_shipping: false`
and no rate, before and after the locality was set.

**Time.** From the laptop each call took 0.9 to 2.8 seconds, a whole exchange
3 to 5 seconds, most of it new TLS connections across the network. From inside
the test channel's dashboard container, which reaches the shop through the
TEST hairpin route (`deploy/README.md`), three whole exchanges took 200, 142
and 118 milliseconds.

## Reading against the decision rule

P1 and P2 hold. P3 failed as it was written, and its failure is not the one
the rule stops on: "no rate" is told apart from an error. The rule was read as
allowing the build, and the product owner, to whom the deviation was brought
back, confirmed that reading on 2026-10-09.

The build changes in one way because of it. The connector sends all four
fields of the locality on every `update-customer`, with an empty string for a
field the address does not have, so nothing of the shop's own base location
leaks into a price.

The state goes to the shop as the agent wrote it. That works where
WooCommerce's codes are ADR-0032's codes, as for Indonesia and the United
States, and where the agent gave no state. For a country whose codes
WooCommerce writes its own way the shop refuses the state, and the agent is
told the parcel is not available rather than given a price. Translating the
code through the shop's own list of states was considered and put off by the
product owner on 2026-10-09 as a question to settle before parcels sell on
the live channel (`00-open-questions.md`). Two forms of translation were
weighed: the country and a hyphen before the state is safe, while the country
and the state run together is not, because WooCommerce numbers China's
provinces its own way — its `CN11` is Jiangsu, while `11` was Beijing's ISO
numeric code — so a buyer in Beijing would be priced and labelled for another
province.
