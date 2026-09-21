# WooCommerce integration lab

This is the disposable WooCommerce merchant used to exercise the Agentify
connection flow against a realistic self-hosted shop. It is served at
`https://woo.nuanu.ai`; the title is the only prominent indication that it is
a test store. The catalogue contains five virtual gift cards with ordinary
descriptions, prices and dedicated product photography. No WooCommerce payment
gateway is enabled.

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
replaces the two baseline archives. A normal reset never enters it.

Run `./verify.sh` afterward to check public DNS, the catalogue through the
private side of the shared ingress, and payment-method state. It needs two
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
