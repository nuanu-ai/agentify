# WooCommerce integration lab

This is the disposable WooCommerce merchant used to exercise the Agentify
connection flow against a realistic self-hosted shop. It is served at
`https://woo.nuanu.ai`; the title is the only prominent indication that it is
a test store. The catalogue contains five virtual gift cards with ordinary
descriptions, prices and product artwork. No WooCommerce payment gateway is
enabled.

The shop runs as an isolated Compose project on `dmitry-dev`. Its WordPress,
MariaDB and Caddy data live under
`/home/dmitry/.codex-project-storage/woocommerce-lab`, on the large data disk.
Only Caddy is published, on `10.20.10.20:9444`; the shared Comino ingress sends
the public hostname to that listener without terminating TLS.

## Reset the shop

Run this on `dmitry-dev`:

```sh
cd /home/dmitry/woocommerce-lab
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

Run `./verify.sh` afterward to check the public catalogue and payment-method
state. `./verify-reset.sh` is the destructive acceptance check: it creates an
extra product, performs a normal reset, and proves the mutation disappeared
within one minute while Caddy's state remained. Administrator credentials are
printed by the reset command and stored only in the server-owned `.env` file.
