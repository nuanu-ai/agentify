# WooCommerce integration lab

This is the disposable WooCommerce merchant used to exercise the Agentify
connection flow. It is served at `https://woo.nuanu.ai`; the title is the only
prominent indication that it is a test store.

The lab keeps four shops, called profiles, and runs one of them at a time. The
basic profile is built to exactly what the connector demands, and that is what
it is for: it shows the connector doing what it was designed to do. The
realistic profile is a shop shaped like the Indonesian WooCommerce shops
counted in the census of real shops, priced in rupiah, and the realistic-usd
profile is the same shop priced in US dollars. The hard profile is the
realistic shop grown to just under the number of products the connector
imports, with tax calculated and several shipping zones, where size, tax and
parcels meet. Each profile is built once from a clean baseline and stored as a
snapshot of the shop's database and files; switching to a profile restores its
snapshot in seconds, without the network, and checks that the shop is that
profile. Overlays change a few settings of the running profile, such as how it
calculates tax, without rebuilding it, and a switch takes them away again.

The shop runs as an isolated Compose project on the fixture host. Its
WordPress, MariaDB and Caddy data, the baseline and the stored profiles live
under the directory named by `WOOCOMMERCE_DATA_ROOT`, on that host's large data
disk. Only Caddy is published, on the address and port the operator gives it;
the shared ingress sends the public hostname to that listener without
terminating TLS. Which host, which directory and which addresses are deployment
facts and live with the operator, not in this repository.

## The command

Everything is done with `./lab.sh`, run on the fixture host from the directory
the lab is checked out into. It reads the deployment facts and the passwords
from the lab's server-owned `.env`, and it reaches files the database,
WordPress and Caddy own through a container of its own, so the operator needs
no sudo beyond whatever the host requires for Docker.

```console
$ ./lab.sh list
basic          built 2026-10-22T07:44:44Z from 9d2b6e6f8360, check passed, 57 MB stored, 56s to build
hard           built 2026-10-22T08:04:47Z from 9d2b6e6f8360, check passed, 113 MB stored, 174s to build
realistic      built 2026-10-22T07:50:33Z from 9d2b6e6f8360, check passed, 88 MB stored, 107s to build
realistic-usd  built 2026-10-22T07:52:15Z from 9d2b6e6f8360, check passed, 88 MB stored, 101s to build
Not built: none
$ ./lab.sh switch hard
ok    the shop says it was built as this profile
ok    the overlays it records
ok    products in the public catalogue
…
Success: The shop is the hard profile.

The shop is the hard profile, switched in 25.4s. Orders, customers, REST API keys and
any Agentify connection to the shop are gone: a connected merchant connects again.
$ ./lab.sh overlay over-limit
51 copies of Chili Sambal Sachet added; the public catalogue lists 2001 products.
…
$ ./lab.sh overlay tax-per-line
…
$ ./lab.sh status
Running:   caddy db mailpit wordpress
Profile:   hard
Overlays:  over-limit, tax-per-line
Built:     2026-10-22T08:04:47Z from revision 9d2b6e6f8360, with uncommitted lab changes; its check passed
In the shop: profile hard, overlays over-limit, tax-per-line
REST keys: 0
```

That session ran on a throwaway copy of the lab on a laptop, before its
changes were committed, which is why the revision carries uncommitted changes.

`./lab.sh status` says which profile and overlays the shop runs, whether the
lab's files have changed since that profile was built, and whether any REST API
keys exist, which is how a connected Agentify merchant reaches the shop.
`./lab.sh list` names the stored profiles, when and from which revision each
was built, the result of its check and its size. `./lab.sh check` checks the
running shop against its profile and overlays, and `./lab.sh check --as
<profile>` against another one, which fails; it is the negative control for
the check itself. `./lab.sh` alone prints every command.

## What a switch does to a connected merchant

A switch replaces the shop's whole database and WordPress files with the
profile's snapshot. Everything the shop held is gone afterwards: orders,
customers, coupons, the mail in the mail catcher, and every WooCommerce REST
API key, including the key an Agentify merchant connected to the shop holds.
Agentify is not told: the merchant's integration still names the shop, and
every request it makes with the old key is refused until the merchant connects
the shop again from the dashboard. After every switch, a connected merchant
reconnects. Product numbers can also differ between profiles, so a story
identifies products by SKU or name and records their numbers after the switch.

An overlay changes settings or, for `over-limit`, adds products, and leaves
orders and keys alone, so a connected merchant stays connected; whether the
connector still accepts the shop under the new settings is what the story
tests. Caddy's certificate state survives both.

## The basic profile

The basic catalogue holds three groups of product, and the difference
between the first two is what the profile exists to show. Five virtual gift
cards, with ordinary descriptions, prices and dedicated product photography,
promise a brunch, a dinner for two, a wellness day, a creative workshop and a
weekend away. No file can deliver any of those, so the cards carry none, and
when a merchant imports the catalogue the Agentify connector must name each of
them and leave it in the shop rather than sell an order number in place of the
experience.

Two inexpensive downloads, a pack of gift-message templates and a gift-wrapping
guide, are the opposite case: each is a plain-text file from `seed/downloads/`,
and that file is the whole of what the product promises. One price is typed
with cents and the other without, the two ways a merchant writes a price into
WooCommerce, which keeps it as written. They are built to the one class of
download the connector imports, described in
[ADR-0023](../../docs/decisions/0023-woocommerce-connect.md): a published,
in-stock simple product, virtual and downloadable, without managed stock and
not sold individually, carrying exactly one file that can be downloaded any
number of times and never expires. When an agent buys one, the connector hands
it three things: WooCommerce's own download link for that order, the file's
name and the shop's order number. WooCommerce then serves the bytes to whoever
opens the link, so the file has to sit in WooCommerce's protected upload
directory, where a direct request is refused and only an order's download link
retrieves it. The profile also sets the shop settings the connector reads
before it imports or sells anything: prices in US dollars, tax calculation
off, Force Downloads, no redirect fallback, no login required to download, and
access granted once an order is paid.

The third group is one physical product, a tote bag, and the shipping zones
that price it, which `seed/parcel.php` adds. It is the second class the
connector imports: a published, in-stock simple product that is neither
virtual nor downloadable, whose shipping is WooCommerce's own rate for the
buyer's locality. The zones are keyed one each by a state (Bali), by a postcode
pattern (San Francisco) and by a country (the rest of Indonesia, at two
rates), and every other place has no rate, so the shop does not ship there.

The basic profile runs WooCommerce with no other plugin, enables no payment
method a customer could use, and sends its mail to nobody who reads it. A real
shop differs in each of those ways, so a pass on it says nothing about one.
Its check confirms the eight products by SKU, the prices of the downloads and
the tote, each download's file against its copy in `seed/downloads/`, the
connector's shop settings, tax calculation off, the three zones with their
rates, and that no other plugin, payment method or must-use plugin is there.

## The realistic profile

The realistic profile is a shop shaped like the Indonesian WooCommerce shops
counted in the census of real shops
([research note 55](../../docs/research/55-woo-shop-census.md)), whose decision
rule fixed what the profile contains. The `realistic` profile prices it in
rupiah, written with no decimals, a point between thousands and the symbol
before the amount, as most of those shops write it. The `realistic-usd`
profile prices the same catalogue in US dollars, every rupiah price taken at
Rp 16.000 to the dollar, a round rate chosen for the lab rather than a market
rate, so that the dollar prices carry cents. The connector sells from the
rupiah shop at a rate its merchant sets on the dashboard's WooCommerce page,
and publishes nothing from it until one is set.

The profile installs, from wordpress.org and at the versions pinned in
`seed/plugins.txt`, the plugins the census saw on at least a fifth of the
Indonesian shops: Elementor 4.3.5, Contact Form 7 6.2.3, Xendit's plugin for
Indonesian virtual accounts (`woo-xendit-virtual-accounts`) 8.0.0, Click to
Chat for WhatsApp 4.45 and Google Site Kit 1.190.0. Elementor Pro, the sixth,
is sold by its vendor and is not published on wordpress.org, so the profile
does not reproduce it. The plugins are downloaded when the profile is built and
are part of its snapshot, so a switch needs no network. They are installed and
active but not configured as a merchant would configure them: Site Kit is
connected to no Google account, Click to Chat has no phone number, no page is
built with Elementor, and Xendit's payment methods stay off, because they need
the keys of a Xendit account the lab does not have. What the plugins change by
being active, in the shop's settings, its pages and its Store API, is
therefore present; what they change once a merchant has set them up is not.

The catalogue is 113 products in eight categories, 84 of them simple and 29
variable with 124 variations between them. Of the simple products in stock, 24
count their stock, at quantities from 1 to 250; seven products are out of
stock, fifteen are on sale at a third, two fifths or half off, five can be
bought only one at a time, and four made-to-order pieces of furniture have no
price, as a shop shows a piece whose price it gives on request. Every product
is physical, has a SKU by which a story can find it, and carries a plain name
and a short description written for the lab; none has a photograph or a
weight. The shop ships to Indonesia only, through one shipping zone with one
flat rate, Rp 24.000 or 1.50 US dollars, which is the least a customer's order
for a physical product needs; the census did not measure shipping. Tax
calculation is off, because the census could not see whether the shops
calculate tax; the hard profile and the tax overlays below turn it on.

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
the census saw.

A person can order in the profile as an ordinary customer: it enables
WooCommerce's direct bank transfer, so an order placed through the storefront
or the Store API checkout waits on hold for a payment nobody makes. The shop's
mail goes to a mail catcher, Mailpit, which runs as the `realistic` Compose
profile's one service while the realistic, realistic-usd or hard profile is
active, and which keeps mail only while it runs; a switch discards it. The
profile adds a must-use plugin to WordPress that hands every message to it, so
the customer's mail and the administrator's, whatever address a story gives
the customer, land there and reach no real mailbox. Its web interface listens
on port 8025 of the fixture host's loopback only and is read through a tunnel:

```sh
ssh -L 8025:127.0.0.1:8025 <fixture host>
```

The check of the realistic profiles confirms the catalogue's size and make-up
listed above, the prices of three products by SKU, the currency and how it is
written, the one zone and its rate, the plugins at their pinned versions, bank
transfer as the only payment method, the mail catcher's must-use plugin, and
tax calculation off.

## The hard profile

The hard profile is the realistic shop in rupiah grown to 1,950 products, just
under the 2,000 the connector imports, so that one import reads the whole
catalogue and the `over-limit` overlay needs only fifty-one more. It keeps the
census's shape at that size. Of the 1,950 products, 1,451 are simple (74%) and
499 variable, with 2,250 variations between them, four or five each; 398
simple products count their stock, about 30% of the simple products in stock;
117 are out of stock (6%), 244 on sale at a third, two fifths or half off
(12.5%, against the census's 13%), 79 sold one at a time (4%), and 994 give a
weight (51%, the census's share of products with a weight or dimensions).
Sixty-nine pieces of furniture are made to order and have no price, the
realistic profile's share of four in 113. The 113 realistic products are kept, and the
others are generated in the same eight categories, in the same proportions
between categories, from lists of plain product names and the colours, sizes,
motifs and packs that tell them apart. Each generated price is the price of a
realistic product of the same category moved by one of a fixed series of
factors and rounded as the realistic prices are, so the prices keep the
census's spread. Every name, price and flag follows from a product's position,
so a rebuild gives the same shop. The lab's two downloads are there too, priced
at Rp 16.000 and Rp 32.000, the basic profile's dollar prices at the lab's
rate, with the same protected files.

Tax is calculated the one way the connector sells from a shop that calculates
it: prices are entered including tax, shown including tax in the shop and the
cart, tax is based on the customer's shipping address and rounded at the
subtotal, which is the `tax-incl` overlay below. The shop is based in
Denpasar, Bali, with one rate for Indonesia, PPN at 11%, applied to shipping
too, and no rate for any other country. The shipping zones are the basic
profile's, priced in rupiah at the lab's rate and taxed: Bali by its state at
Rp 48.000, the San Francisco postcodes at Rp 120.000, the rest of Indonesia by
its country at Rp 80.000 or Rp 192.000 express. A buyer in San Francisco is
therefore the place the tote ships to at a different rate, none, and every
place outside the three zones is one the shop does not ship to. The hard
profile has the realistic profile's plugins, bank transfer and mail catcher.

Indonesia's VAT, PPN, is 12% by law, but since 1 January 2025 it is charged for
goods that are not luxury goods on a base of eleven twelfths of the price, so
the tax a shop charges is 11% of the price (Minister of Finance Regulation
131/2024, article 3, as the Directorate General of Taxes explains it in
[PMK 131/2024: Tarif PPN Sebelas-Dua Belas](https://www.pajak.go.id/id/artikel/pmk-1312024-tarif-ppn-sebelas-dua-belas)).
Exports of goods are taxed at 0% (article 7(2) of the VAT law as amended by
Law 7/2021), which the Directorate General's press release of 3 January 2025,
[PPN 2025: Kebijakan Baru, Beban Pajak Tetap Ringan untuk Masyarakat](https://www.pajak.go.id/en/node/113455),
confirms is unchanged. Both were read on 2026-10-22. The rate is one setting,
`LAB_PPN_RATE` in `seed/overlays.php`; changing it changes the hard profile at
its next build and every tax overlay at once. Like research note 56, the lab
gives exports no rate rather than a rate of zero.

## Overlays

An overlay is laid over the running profile with `./lab.sh overlay <name>`,
takes seconds, and is checked as soon as it is laid: the check is the
profile's own, with the overlay's settings in place of the profile's. The
shop records the overlays laid since the last switch, `status` names them, and
switching to a profile, even the one already running, clears them.

The tax overlays set the tax modes the stories about tax need, exactly as
research note 56's Indonesian shop set them: the shop based in Denpasar, Bali
(`ID:BA`, 80361), tax calculated, tax based on the customer's shipping address
and rounded at the subtotal, and one rate, PPN at 11% for Indonesia applied to
shipping, unless the overlay names otherwise. Each replaces the shop's tax rates
with that one rate, and a tax overlay replaces any tax overlay laid before it.
None changes a product or the tax status of a shipping rate: on the basic
profile the zones stay untaxed as `seed/parcel.php` makes them, and on the hard
profile they stay taxed.

- `tax-incl`: prices entered including tax, shown including tax in the shop
  and the cart. This is the one mode the connector sells from.
- `tax-excl`: prices entered excluding tax and shown excluding tax, as a shop
  that enters them so shows them.
- `tax-per-line`: as `tax-incl`, with tax rounded per line instead of at the
  subtotal.
- `tax-shop-shows-excl`: as `tax-incl`, with prices shown in the shop excluding
  tax although they are entered including it.
- `tax-cart-shows-excl`: as `tax-incl`, with prices shown in the cart and the
  checkout excluding tax.
- `tax-on-billing`: as `tax-incl`, with tax based on the customer's billing
  address.
- `tax-on-base`: as `tax-incl`, with tax based on the shop's base address.

Choosing a tote price and a shipping cost at which rounding per line and at the
subtotal give totals a cent apart is part of the story that needs it, not of
the overlay, because it changes the catalogue.

`over-limit` adds copies of the shop's oldest priced simple product, named and
given SKUs `OVER-LIMIT-0001` onwards, until the public catalogue lists 2,001
products, one more than the connector imports. It takes about fifty-one
products on the hard profile and nearly two thousand on the basic one, so it
takes seconds on the first and a minute or two on the second. It can be
combined with a tax overlay.

## Settings readings

A settings reading records, at one moment, every WooCommerce option and the
WordPress settings a shop depends on: the site and home addresses as stored and
as in effect, permalinks, the time zone, the administrator's address and
WooCommerce's sender, whether anything redirects outgoing mail, every plugin
and must-use plugin with its version and whether it is active, the theme, the
payment methods and whether each is enabled, the shipping zones with their
places and methods, the tax classes and rates, webhooks, and the REST API keys.
A key is recorded by its description, user, permissions and last access only;
its secret, its hash and its last characters never are. Any other value held
under a name that marks a secret, such as a payment plugin's secret key, is
recorded as a hash keyed with the installation's own salt, so that two readings
show that it changed without showing it. Transients and caches are left out
because they change on their own.

```sh
./lab.sh settings save before-connect
./lab.sh settings save after-connect
./lab.sh settings diff before-connect after-connect
./lab.sh settings list
```

The difference is printed one setting a line, grouped by section, as added,
removed or changed with the earlier and the later value. Readings are kept in
`$WOOCOMMERCE_DATA_ROOT/readings`, survive switches, and are never
overwritten. WooCommerce keeps some bookkeeping of its own among its options,
such as when it last ran a scheduled task, and a difference there is real but
usually not the story's.

## Building the profiles

A profile is built from the clean baseline, which holds the basic profile's
gift cards and downloads without the tote, by restoring the baseline, laying
the profile's seed over it, running the profile's check, and storing the
result only if the check passes:

```sh
./lab.sh build all        # or one profile: ./lab.sh build hard
```

The realistic and hard profiles download their plugins from wordpress.org
while they are built. A stored profile is three files under
`$WOOCOMMERCE_DATA_ROOT/profiles/<name>/`: the database's own files, copied
while it was stopped, WordPress's files, and a manifest naming the revision of
this repository that built it, whether the lab's files had uncommitted changes,
when it was built, the MariaDB image whose files it holds, the size of each
archive and the full output of its check. A switch refuses a profile whose
check did not pass or whose database image is not the one the lab now runs,
and `status` says when the lab's files have changed since the running profile
was built. The new profile replaces the stored one only once it is complete,
and the shop runs it afterwards.

The baseline itself is rebuilt only when the clean starting catalogue must
change:

```sh
./lab.sh baseline
```

That downloads WordPress's plugin and theme from wordpress.org and replaces
the baseline's database dump and WordPress archive; every profile is built
again from it afterwards. On a new installation the same command creates the
server-owned `.env`, with the deployment facts given to it and new passwords:

```sh
WOOCOMMERCE_DATA_ROOT=<directory holding the lab data> \
WOO_LAB_LISTEN_ADDRESS=<address the lab Caddy binds on> \
  ./lab.sh baseline
```

A rebuilt baseline starts from an empty database and can renumber products,
so a product number recorded against an older profile may name a different
product afterwards.

## Checking the lab from outside

Run `./verify.sh` with the basic profile active to check public DNS, the basic
catalogue through the private side of the shared ingress, and payment-method
state. For the catalogue it checks both halves: that the gift cards still carry
no file, and that each download is in the class the connector imports,
including a request for its file that WooCommerce refuses without an order's
download permission. Because that refusal looks the same whether or not a file
is there, it also compares each file inside the WordPress container with its
copy in `seed/downloads/`. It checks that every public price equals, as an
amount, the price WooCommerce keeps, and it reads the shop settings the
connector depends on. It needs two addresses and refuses without them, naming
what is missing:

```sh
WOO_LAB_PUBLIC_IP=<address the shop hostname resolves to> \
WOO_LAB_INGRESS_IP=<address behind that one> \
  ./verify.sh
```

`./verify.sh --static` checks only that the lab's files resolve and needs
neither. Public edge availability is checked from outside the fixture host,
which cannot hairpin through the shared public address. `./verify-reset.sh` is
the destructive acceptance check: it creates an extra product, switches to the
basic profile, and proves the mutation disappeared within one minute while
Caddy's state remained.

## What the profiles leave out

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
