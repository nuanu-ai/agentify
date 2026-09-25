# WooCommerce integration lab

This is the disposable WooCommerce merchant used to exercise the Agentify
connection flow against a realistic self-hosted shop. It is served at
`https://woo.nuanu.ai`; the title is the only prominent indication that it is
a test store. No WooCommerce payment gateway is enabled.

The catalogue holds two groups of product, and the difference between them is
what the lab is for. Five virtual gift cards, with ordinary descriptions,
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
