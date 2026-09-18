# Walking the WooCommerce Connect flow by hand

Operational examples below use the current Agentify identifiers. Product names
and synthetic identifiers in recorded historical output have been normalized
to match; this is not evidence of a new execution of the renamed stand.
Other measured values are retained. Original transcripts remain in Git history.
A pre-existing local stand must be handled separately; changing its Compose
project name does not migrate its WordPress data.

This is the runbook for one person at a laptop: bring up a WooCommerce shop and
a Agentify stack, connect the two through the cabinet, import the shop's
catalogue, buy one of its products as an agent, and find the paid order in
wp-admin. Commands and unqualified output below were observed on the clean
stand. The import refusal is explicitly marked where it was reconstructed and
shortened rather than observed.

It is a laboratory. Three things here exist only because the whole arrangement
is on one machine, and each of them is marked where it appears; nothing in the
product code depends on any of them.

## Before anything

Docker, Node and `pnpm`. One line in `/etc/hosts`:

```
127.0.0.1 cabinet
```

That name is the only piece of laptop plumbing you have to arrange yourself, and
it is worth a sentence about why. WooCommerce refuses to send the granted keys
to a callback address that is not https, and WordPress will only make an
outgoing request to ports 80, 443 and 8080. The shop reaches the cabinet by the
service name `cabinet` on the stand's own network; this line makes your browser
reach the same name, so that the one address we hand WooCommerce works from both
sides. On a deployed cabinet this is real TLS on 443 and there is nothing to
arrange.

## 1. The shop

```sh
cd spikes/woo
./demo.sh
```

`demo.sh` brings the shop up (running `./setup.sh`, which is safe to re-run),
moves it onto https, switches on the stand's two local allowances, and starts a
TLS terminator in front of where the cabinet will be. It prints what to do next,
which is the rest of this file.

Three things it changed, all of them the laptop rather than the product:

- **The shop is on https now.** WooCommerce picks its REST authentication scheme
  from its own `is_ssl()`, and the cabinet speaks the https one — it refuses an
  http shop at the door, because over http a merchant's own secret would be on
  the wire on every order.
- **A TLS terminator is in front of the cabinet**, on 443, with a certificate
  minted into `var/certs/` at setup time and never committed.
- **The mu-plugin's two allowances are on**, by way of the flag file they are
  gated behind: the shop may reach a private address, and its outgoing TLS is
  pinned to this stand's certificate rather than switched off. Both are recorded
  in `README.md` as artefacts of the laboratory.

The shop is now at **https://localhost:8443**, and wp-admin at
**https://localhost:8443/wp-admin** (`admin` / `agentify-dev-admin`). The
certificate is self-signed, so the browser asks once. Sign in there now — the
grant screen later needs your shop session.

## 2. The Agentify stack

From the root of the checkout:

```sh
docker compose up -d --build
docker compose stop cabinet
```

The second line is not tidiness. The stack runs a cabinet of its own at
`http://localhost:8080/cabinet`, and the one you are about to run on the laptop
shares its database — two cabinets would both fill the same merchant's orders,
and the one in the container cannot reach a shop at `localhost:8443`, because
inside a container that is the container. So there is one cabinet, and it is
yours. `http://localhost:8080/cabinet` answers 502 until you start the stack's
own again; everything else on 8080 — the landing, the docs, `/v0`, `/x402` — is
unaffected.

## 3. The cabinet

On the laptop, from the root of the checkout, with the stand's certificate
trusted so that it can read the shop:

```sh
NODE_EXTRA_CA_CERTS=$PWD/spikes/woo/var/certs/shop-cert.pem \
DATABASE_URL=postgres://agentify_commerce:agentify_commerce@localhost:5432/agentify_commerce \
GATEWAY_URL=http://localhost:8080 \
PUBLIC_BASE_URL=https://cabinet \
COOKIE_SECURE=true \
AUTH_SECRET=a-sandbox-secret-nobody-should-reuse-anywhere \
PAYMENT_NETWORK=eip155:84532 FACILITATOR_URL=sandbox:scripted \
PORT=3001 pnpm --filter @agentify/commerce-cabinet start
```

It says what it is doing:

```
[cabinet] listening on 3001, reading http://localhost:8080
[cabinet] no mail provider is configured: every message is written to this log instead
```

`NODE_EXTRA_CA_CERTS` is the third and last of the laboratory's pieces: the
shop's certificate is self-signed, and a real merchant's is not.

Leave this terminal running. It is also where you watch the connection being
made and the orders being filled.

## 4. Register, and name yourself

Open **https://cabinet/register** — the browser asks about the certificate once.

The form wants an address, a password and an invitation. The invitation is
`register-on-this-laptop`, which `compose.yaml` sets by default. Registering
signs you in and puts you on the one question the form did not ask: the name
buyers read beside your products. Anything printable and short — `Probe Stand
Shop` will do.

Nothing else is needed before selling. This stack settles against nothing
(ADR-0008), so a payout wallet is not asked for.

## 5. Connect the shop

Settings → **Connect a WooCommerce shop**, or straight to
**https://cabinet/woocommerce**.

Type `https://localhost:8443` and press Connect. Three things happen, and only
the first is visible:

1. The cabinet asks your shop, from its own process, whether the address it is
   about to send you to actually reaches WooCommerce's grant screen. A shop
   whose permalinks are set to Plain answers that address with its own front
   page and a `200`, so without this you would land on your shop with nothing to
   report. If you want to see the refusal, set Settings → Permalinks to Plain in
   wp-admin and press Connect again: the page names the setting and sends you
   nowhere.
2. Your browser goes to your shop's grant screen, which says what Agentify is
   asking for. Press **Approve**.
3. Your shop's own server posts the freshly minted key pair to the cabinet, and
   your browser comes back to a page that reads the connection rather than the
   `success=1` on the redirect. The terminal says:

```
[cabinet] woo-merchant@example.com started connecting the WooCommerce shop at https://localhost:8443
[cabinet] a WooCommerce shop was connected for an account: https://localhost:8443, read_write
```

and the page says **Your shop is connected. The keys arrived from your shop's
own server, which is what settles it.**

If it says instead that no keys have reached us yet, the page is reporting what
is in its own rows rather than what the redirect claims: the keys travel on a
request from your shop's server, separately from your browser, and the page
cannot see whether that request is still on its way, was never made, or did not
get through. Reload. After fifteen minutes the page stops waiting for that
Connect, says no keys arrived in that time, and offers Connect again.

The keys are now visible to you as the merchant, in your own shop, under
WooCommerce → Settings → Advanced → REST API, named `Agentify`.

## 6. Import the catalogue

Press **Import the catalogue**. On the stand's three seeded products the answer
is:

```
2 products published, 1 refused by our publishing rules.

Published
  Canvas tote bag — product 11 in your shop, card item_…
  Access code — product 10 in your shop, card item_…

Refused
  Абонемент на месяц — product 12
    description: this description is 856 characters and a listing carries at most 500 — the ceiling is the one the discovery catalog documents, not ours and not the payment protocol's
```

The refusal in that block is reconstructed and not quoted, and so are the line
of counts and the headings over both lists: the walk this runbook records
was made against earlier wordings of all four, and what stands above is
today's. The paragraph the screen draws under each heading is left out of the
block. The 856 is `setup.sh`'s
`LONG_RU_DESC` measured through the cabinet's own `plainTextOf`. The rest of the
block is as it came back. Rerunning section 6 would settle it, and nobody has.

That third line is the point of the screen. The card was refused by the ordinary
publish door, in the door's own words, and nothing shortened the merchant's
description to make it fit. The seeded description is 856 characters of prose,
which WooCommerce stores wrapped in a `<p>` and its closing tag and the Store
API therefore reports as 863; a card is made from the prose inside, so 856 is
the number the refusal counts and 500 is the number it is measured against.

The two that went through are priced from the Store API's minor units and the
scale beside them: the tote bag's `"2500"` at a scale of two is `25.00`, not
`2500`.

## 7. Buy one, as an agent

From the root of the checkout, in another terminal:

```sh
GATEWAY_URL=http://localhost:8080 pnpm --filter @agentify/commerce-slice buy "Canvas tote bag"
```

```
[buyer] 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266 against http://localhost:8080
[buyer] buying item_… — Canvas tote bag, listed at 25.00 USD
[buyer] answered 200
{
  "order_id": "ord_e2bf32bcf0d24a459f9d0ce688bacccf",
  "status": "delivered",
  "price": { "amount": "25.00", "currency": "USD", … },
  "delivered": { "order_number": "16" },
  "test": true
}
```

The agent paid, and what it received is the number its order has in a shop it
has never heard of.

## 8. Find the order in wp-admin

**https://localhost:8443/wp-admin** → **WooCommerce → Orders**. The order is
there, numbered as the agent was told, with the status `Processing`, the total
`$25.00` and the payment method `Agentify`.

Open it. Two fields are worth reading:

- **Transaction ID** is the Agentify order identifier — `ord_e2bf32bc…` above.
  It is the one thread between an order here and an order there, and it is what
  you search for if the two ever have to be reconciled by hand.
- **Billing email** is your own account address, not the buyer's. Creating an
  order makes WooCommerce send mail, to you and to whatever address is on the
  order, and nothing in the request can suppress either; whose address belongs
  there is a product question nobody has answered, and ADR-0023 says so rather
  than pretending it is settled. On this stand the container has no mail
  transport, so both attempts fail and are recorded in `var/probe/mail.jsonl`.

The same facts read from a terminal, if you would rather not click:

```sh
cd spikes/woo
docker compose run --rm -T cli wp wc shop_order get 16 --user=admin \
  --fields=id,status,total,currency,payment_method,transaction_id,date_paid --format=table
```

```
id               16
status           processing
currency         USD
total            25.00
payment_method   agentify
transaction_id   ord_e2bf32bcf0d24a459f9d0ce688bacccf
date_paid        2026-09-14T07:57:09
```

And the same sale from the merchant's side, at **https://cabinet/orders**.

## Putting it away

```sh
cd spikes/woo && ./setup.sh --reset      # the shop, its volumes and its certificates
cd ../.. && docker compose down          # the Agentify stack
```

Stop the cabinet in its terminal. The `/etc/hosts` line is harmless and can
stay.

## What to try if you want to see the refusals

Each of these is a screen this flow has, reached by breaking one thing:

- **Plain permalinks.** wp-admin → Settings → Permalinks → Plain, save. Press
  Connect: the cabinet names the setting and sends you nowhere.
- **An http shop.** Type `http://localhost:8088` into the Connect box. Refused
  before your shop is asked anything, with the reason — your secret would be on
  the wire on every order.
- **A read-only grant.** Not reachable from the grant screen, which grants what
  was asked for; if a shop ever grants less, the connection page says so and
  every sale is refused at delivery with a sentence naming it.
- **A second import.** Press Import again. The same products come back as the
  same cards rather than as a second set, because a card is keyed by the
  product's own identifier in the shop.
