# WooCommerce integration lab

This is the disposable WooCommerce merchant used to exercise the Agentify
connection flow. It is served at `https://woo.nuanu.ai`; the title is the only
prominent indication that it is a test store.

Its baseline shop, which a reset restores, is built to exactly what the
connector demands, and that is what it is for: it shows the connector doing
what it was designed to do. It prices in US dollars with tax calculation off,
runs WooCommerce with no other plugin, holds a handful of products none of
which counts its stock, enables no payment method a customer could use, and
sends its mail to nobody who reads it. A real shop differs in each of those
ways, so a pass on the baseline says nothing about one. The realistic profile,
described in its own section below, lays a shop shaped like the real ones over
the baseline for the stories that need it, and a reset takes it away again.

The baseline catalogue holds two groups of product, and the difference
between them is what the baseline exists to show. Five virtual gift cards, with ordinary descriptions,
prices and dedicated product photography, promise a brunch, a dinner for two, a
wellness day, a creative workshop and a weekend away. No file can deliver any of
those, so the cards carry none, and when a merchant imports the catalogue the
Agentify connector must name each of them and leave it in the shop rather than
sell an order number in place of the experience.

Two inexpensive downloads, a pack of gift-message templates and a gift-wrapping
guide, are the opposite case: each is a plain-text file from `seed/downloads/`,
and that file is the whole of what the product promises. One price is typed
with cents and the other without, the two ways a merchant writes a price into
WooCommerce, which keeps it as written. They are built to the one class of
product the connector imports, described in
[ADR-0023](../../docs/decisions/0023-woocommerce-connect.md): a published,
in-stock simple product priced in US dollars, virtual and downloadable, without
managed stock and not sold individually, carrying exactly one file that can be
downloaded any number of times and never expires. When an agent buys one, the
connector hands it three things: WooCommerce's own download link for that
order, the file's name and the shop's order number. WooCommerce then serves the
bytes to whoever opens the link, so the file has to sit in WooCommerce's
protected upload directory, where a direct request is refused and only an
order's download link retrieves it. The seed also sets the shop settings the
connector reads before it imports or sells anything: prices in US dollars, tax
calculation off, Force Downloads, no redirect fallback, no login required to
download, and access granted once an order is paid.

A third group is one physical product, a tote bag, and the shipping zones that
price it, which `seed/parcel.php` adds. It is the second class the connector
imports: a published, in-stock simple product in US dollars that is neither
virtual nor downloadable, whose shipping is WooCommerce's own rate for the
buyer's locality. The zones are keyed one each by a state (Bali), by a postcode
pattern (San Francisco) and by a country (the rest of Indonesia, at two
rates), and every other place has no rate, so the shop does not ship there.
The script can be run on its own against a shop that already holds the rest
of the seed, and running it again changes nothing:

```sh
sudo -n env WOO_LAB_LISTEN_ADDRESS=<address the lab Caddy binds on> \
  docker compose run --rm -T cli wp eval-file - < seed/parcel.php
```

It is not part of the baseline, so a reset removes it and the script is run
again afterwards. `./verify.sh` checks the seeded catalogue alone and counts the
tote bag as one product too many.

The shop runs as an isolated Compose project on the fixture host. Its
WordPress, MariaDB and Caddy data live under the directory named by
`WOOCOMMERCE_DATA_ROOT`, on that host's large data disk. Only Caddy is
published, on the address and port the operator gives it; the shared ingress
sends the public hostname to that listener without terminating TLS. Which host,
which directory and which addresses are deployment facts and live with the
operator, not in this repository.

## Reset the shop

Run this on the fixture host, from the directory the lab is checked out into.
For an existing installation, keep these values in its server-owned `.env`;
for the first initialization, supply them explicitly and the reset command
persists them there:

```sh
WOOCOMMERCE_DATA_ROOT=<directory holding the lab data and baseline> \
WOO_LAB_LISTEN_ADDRESS=<address the lab Caddy binds on> \
  ./reset-store.sh
```

The command stops only the `agentify-woo-lab` Compose project, replaces its
WordPress files and database from a local baseline, and starts the shop again.
It does not pull images, download WordPress or WooCommerce, or delete Caddy's
certificate state. The baseline lives beside the shop data on the large disk.
The reset deletes orders, customers, coupons, WooCommerce API keys and the
previous Agentify connection. The server-owned `.env` keeps the administrator
password stable across resets.

Rebuild the local baseline only when the clean starting catalogue itself must
change:

```sh
./reset-store.sh --rebuild-baseline
```

That maintenance mode performs the network downloads once and atomically
replaces the two baseline archives. A normal reset never enters it. A rebuild
starts from an empty database, so it also renumbers what follows the gift
cards: on the current baseline they are products 12 to 20, and the downloads
take the numbers after them. A product number above 20 recorded against an
older baseline, such as that of a product someone added by hand, may name a
different product after a rebuild.

Run `./verify.sh` afterward to check public DNS, the catalogue through the
private side of the shared ingress, and payment-method state. For the
catalogue it checks both halves: that the gift cards still carry no file, and
that each download is in the class the connector imports, including a request
for its file that WooCommerce refuses without an order's download permission.
Because that refusal looks the same whether or not a file is there, it also
compares each file inside the WordPress container with its copy in
`seed/downloads/`. It checks that every public price equals, as an amount, the
price WooCommerce keeps, and it reads the shop settings the connector depends
on. It needs two
addresses and refuses without them, naming what is missing:

```sh
WOO_LAB_PUBLIC_IP=<address the shop hostname resolves to> \
WOO_LAB_INGRESS_IP=<address behind that one> \
  ./verify.sh
```

`./verify.sh --static` checks only that the lab's files resolve and needs
neither. Public edge availability is checked from outside the fixture host,
which cannot hairpin through the shared public address. `./verify-reset.sh` is
the destructive acceptance check: it creates an extra product, performs a
normal reset, and proves the mutation disappeared within one minute while
Caddy's state remained. Administrator credentials are printed by the reset
command and stored only in the server-owned `.env` file.

## The realistic profile

The realistic profile turns the restored baseline into a shop shaped like the
Indonesian WooCommerce shops counted in the census of real shops
([research note 55](../../docs/research/55-woo-shop-census.md)), whose
decision rule fixed what the profile contains. It is applied on the fixture
host after a reset, priced in rupiah by default or in US dollars when asked:

```sh
./reset-store.sh
./realistic-profile.sh        # rupiah, written with no decimals
./realistic-profile.sh USD    # US dollars, with cents
```

The connector refuses a shop that prices in rupiah when it is connected,
because it sells in US dollars only. The rupiah shop is the one the census
found, and it is the one for a story about that refusal; a story that must
connect and sell uses the same shop priced in dollars. The script can be run
again over a shop that already holds the profile, in either currency, and
rebuilds the same catalogue. It is not part of the baseline: a reset returns
the shop to the baseline, and unlike a reset the profile downloads its plugins
from wordpress.org every time it is applied. `./verify.sh` checks the baseline
and fails on the profile by design; the profile script ends with its own
check, which reads the public catalogue's size, make-up and currency, the
active plugins with their versions, and the enabled payment methods, and
stops with the first one that is not what it set.

The profile installs, from wordpress.org and at pinned versions, the plugins
the census saw on at least a fifth of the Indonesian shops: Elementor 4.3.5,
Contact Form 7 6.2.3, Xendit's plugin for Indonesian virtual accounts
(`woo-xendit-virtual-accounts`) 8.0.0, Click to Chat for WhatsApp 4.45 and
Google Site Kit 1.190.0. Elementor Pro, the sixth, is sold by its vendor and
is not published on wordpress.org, so the profile does not reproduce it. The
plugins are installed and active but not configured as a merchant would
configure them: Site Kit is connected to no Google account, Click to Chat has
no phone number, no page is built with Elementor, and Xendit's payment
methods stay off, because they need the keys of a Xendit account the lab does
not have. What the plugins change by being active, in the shop's settings, its
pages and its Store API, is therefore present; what they change once a
merchant has set them up is not.

The catalogue replaces the baseline's: 113 products in eight categories, 84 of
them simple and 29 variable with 124 variations between them. Of the simple
products in stock, 24 count their stock, at quantities from 1 to 250; seven
products are out of stock, fifteen are on sale at a third, two fifths or half
off, five can be bought only one at a time, and four made-to-order pieces of
furniture have no price, as a shop shows a piece whose price it gives on
request. Every product is physical, has a SKU by which a story can find it,
and carries a plain name and a short description written for the lab; none
has a photograph or a weight. The shop ships to Indonesia only, through one
shipping zone with one flat rate, Rp 24.000 or 1.50 US dollars, which is the
least a customer's order for a physical product needs; the census did not
measure shipping. Tax calculation stays off as in the baseline, because the
census could not see whether the shops calculate tax, and a story that needs
it on sets it itself.

That shape is the census's measure of the 2,292 products the 29 Indonesian
shops listed through their public catalogue. Their median catalogue held 113
products; 74% of the products listed were simple and the rest, but one
bundle, variable, with a median of four or five variations each; stock was
counted, by the census's inference, for 30% of the simple products in stock;
6% of the products were out of stock, 13% on sale with a median discount of
42%, and 4% sold one at a time. Products without a price made up 27% of all
listed, but almost all of them sat in five shops that show no prices at all,
so the profile keeps four. The prices follow the rupiah prices the shops
showed, with each shop's prices given equal weight so that the largest
catalogues do not set the shape alone: 109 evenly spaced points of that
distribution, rounded to Rp 500 below Rp 100.000, to Rp 1.000 below
Rp 1.000.000 and to Rp 50.000 above, are given in ascending order to a list
of products ordered by what each plausibly costs. The catalogue's prices run
from Rp 2.000 to Rp 40.500.000 with a median of Rp 170.000 and quartiles of
Rp 76.000 and Rp 490.500, against Rp 175.000, Rp 77.000 and Rp 490.000 in the
census. The categories span the kinds of goods the shops sold, food and
drink, body care, phone accessories, clothing, bags, homeware and furniture.
A real shop usually sells one or two of those kinds; the lab puts them in one
shop so that its catalogue covers the whole range of prices and product types
the census saw. Rupiah is written as most of those shops write it, with no
decimals, a point between thousands and the symbol before the amount. The
dollar shop takes every rupiah price at Rp 16.000 to the dollar, a round rate
chosen for the lab rather than a market rate, so that both currencies hold
the same catalogue and the dollar prices carry cents.

A person can order in the profile as an ordinary customer: it enables
WooCommerce's direct bank transfer, so an order placed through the storefront
or the Store API checkout waits on hold for a payment nobody makes. The shop's
mail goes to a mail catcher, Mailpit, which the profile starts as the
`realistic` Compose profile's one service and which keeps mail only while it
runs.
The profile adds a must-use plugin to WordPress that hands every message to
it, so the customer's mail and the administrator's, whatever address a story
gives the customer, land there and reach no real mailbox; the notice
WooCommerce sends when the profile enables bank transfer is the first message
in it. Its web interface listens on port 8025 of the fixture host's loopback
only and is read through a tunnel:

```sh
ssh -L 8025:127.0.0.1:8025 <fixture host>
```

A reset removes the must-use plugin with the rest of the profile but leaves
the mail catcher running with the mail it holds. It is stopped, and its mail
discarded, with:

```sh
sudo -n docker compose --profile realistic stop mailpit
```

Two hosting signals reached the census's threshold and are not reproduced,
because a seed script cannot set them: Cloudflare in front of the shop, and
LiteSpeed as its web server, each on 45% of the Indonesian shops. Putting
Cloudflare in front means serving the shop's hostname, or a test hostname of
its own, through a Cloudflare-proxied DNS record. Cloudflare then terminates
TLS at its edge, so the shared ingress, which today passes TLS through to the
lab's Caddy, and the way Caddy obtains its certificate change too, and
Cloudflare's bot settings decide what the connector meets when it calls. Using
LiteSpeed means replacing the WordPress image's Apache with a LiteSpeed server
built for WordPress, usually together with its LiteSpeed Cache plugin, which
caches pages and can change what a repeated request is answered with. Both
change DNS, the shared ingress or the fixture host, and whether to make those
changes is the operator's decision.
