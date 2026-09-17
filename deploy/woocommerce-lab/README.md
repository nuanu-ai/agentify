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

The command stops only the `agentify-woo-lab` Compose project, deletes only
the four data directories below the exact data root named above, starts a new
WordPress installation, installs WooCommerce and the Storefront theme, disables
all bundled payment methods, and recreates the catalogue. It deletes orders,
customers, coupons, WooCommerce API keys and the previous Agentify connection.
The server-owned `.env` keeps the administrator password stable across resets.

Run `./verify.sh` afterward to check the public catalogue and payment-method
state. Administrator credentials are printed by the reset command and stored
only in the server-owned `.env` file.
