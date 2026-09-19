# WooCommerce integration probe stand

Operational examples below use the current Agentify identifiers. Product names
and synthetic identifiers in recorded historical output have been normalized
to match; this is not evidence of a new execution of the renamed stand.
Other measured values are retained. Original transcripts remain in Git history.
A pre-existing local stand must be handled separately; changing its Compose
project name does not migrate its WordPress data.

A disposable, local WooCommerce shop and three scripted probes. It exists to
answer three pre-registered questions with evidence, before any Agentify code
assumes the answers. It is a spike: nothing here is product code, and the whole
directory is meant to be deleted once its conclusions are recorded.

## The three questions

1. **wc-auth.** WooCommerce has carried a one-click API key grant since 2.4.0
   (2015). The merchant's browser is sent to `/wc-auth/v1/authorize`, the
   logged-in administrator approves, and WooCommerce posts a freshly minted
   `consumer_key` and `consumer_secret` to a callback URL the application
   supplied. Does that still work on a self-hosted shop, and do the keys it
   hands out actually authenticate against `wc/v3`?
2. **Store API.** Does `GET /wp-json/wc/store/v1/products` serve the catalogue
   with no authentication at all, out of the box?
3. **Paid order from outside.** Does `POST /wp-json/wc/v3/orders` with
   `set_paid: true`, using those keys, produce an order the shop itself calls
   paid — and what else does the shop do when it happens?

## Running it

```sh
./setup.sh           # bring the stand up and configure it; safe to re-run
./setup.sh --reset   # destroy the volumes and build it again from nothing
./probe.mjs          # run the three probes and print a verdict for each
./demo.sh            # arrange the stand for walking the flow by hand
```

The first three are the probe and its subject, and they are what the verdicts
below were measured on. `demo.sh` and `DEMO.md` are a second use of the same
stand: a person at a laptop connecting this shop to a Agentify cabinet through
the screens, importing its catalogue, buying one of its products as an agent and
finding the paid order in wp-admin. It changes three things about the stand —
the shop moves onto https, a TLS terminator goes up in front of the cabinet, and
the mu-plugin's two allowances are switched on — and each is explained where it
happens. `./setup.sh --reset` puts the stand back to what the probes measure.

`setup.sh` needs Docker and `openssl`; `probe.mjs` needs Node. Everything else
lives in containers. A verdict is `PASS`, `FAIL` or `BLOCKED(reason)`; `PASS`
and `FAIL` are both answers and exit 0, `BLOCKED` means the probe never reached
the question and exits non-zero.

Ports are 8088 (the shop over http), 8443 (the same shop over https) and 8099
(the callback receiver). None of them collide with the project's own
`compose.yaml`, which publishes 8080 and 5432.

The administrator password is `agentify-dev-admin` and the database passwords
are `wordpress`, both written in plain sight in `setup.sh` and `compose.yaml`.
That is deliberate. The stand is local, disposable and has to be reproducible
from a clean checkout without a secret being passed around; none of these
strings is a credential for anything that exists outside this directory. The
two TLS certificates are generated at setup time into `var/`, which is
git-ignored, so no key material is committed either.

Each `./probe.mjs` run leaves one more order and one more API key in the shop.
That is harmless, and `./setup.sh --reset` clears it.

### Proving the probes can fail

```sh
PROBE_NEGATIVE_CONTROL=1 ./probe.mjs
```

This corrupts the granted secret by one character and asks the catalogue
question of `wc/v3` (which requires authentication) instead of the Store API.
Every verdict must flip. Observed: probe 1 `FAIL` ("Consumer secret is
invalid."), probe 2 `FAIL` (401), probe 3 `BLOCKED` for want of a key pair,
exit 1. A probe suite that only ever reports `PASS` is measuring nothing.

## What is on the stand

WordPress 7.1 and WooCommerce 11.1.0, installed and configured entirely through
WP-CLI — there is no point in the setup where a human clicks through a wizard.
WooCommerce's current release refuses to install on WordPress below 7.0, so the
image is pinned to 7.1 rather than tracking whatever `latest` means today.

Three seeded products, chosen to be awkward in different ways:

| SKU | Name | Shape |
| --- | --- | --- |
| `agentify-access-code` | Access code | virtual, 5.00 USD |
| `agentify-tote` | Canvas tote bag | physical, 25.00 USD, stock-managed |
| `agentify-abonement` | Абонемент на месяц | virtual, Cyrillic title, 856-character description (863 as the Store API reports it, wrapped in a paragraph tag) |

The third exists as material for a later question about what our publish door
should accept; it is not used by any verdict here.

One file on the stand is not stock WooCommerce: `mu-plugins/agentify-probe.php`
records every outbound HTTP request and every mail attempt the shop makes, so
the probes can quote the shop rather than infer from the outside. It also holds
the two local allowances described under probe 1, both gated behind a flag file
so the probes can measure what happens without them first. The allowances name
two hosts on this network — the probes' own key receiver, and the TLS terminator
`demo.sh` puts in front of a cabinet running on the laptop — and nothing else in
the shop is affected by either.

## Results

All three ran green on a stand rebuilt from nothing. Verdicts: `PASS / PASS /
PASS`, exit 0. Every line below is copied from probe output.

### 1. wc-auth one-click key grant — PASS

The grant works, end to end, unattended.

```
GET /wc-auth/v1/authorize -> 200
  approve control is <a href> (a GET), nonce-carrying: http://localhost:8088/wc-auth/v1/access_granted/?app_name=Agentify&user_id=agentify-merchant-1&return_url=…&callback_url=…&scope=read_write&wc_auth_nonce=<nonce>
  page states the scope Read/Write: true
Approve with the local allowances -> 302; Location: https://callback/return?success=1&user_id=agentify-merchant-1
  shop outbound: POST https://callback/wc-auth-callback -> 200
callback receiver got POST application/json;charset=UTF-8 from WordPress/7.1; http://localhost:8088
  payload keys: key_id, user_id, consumer_key, consumer_secret, key_permissions; key_permissions=read_write; user_id=agentify-merchant-1
  consumer_key=ck_ee3…995b (43 chars), consumer_secret=cs_8e3…1572 (43 chars)
GET wc/v3/products over https with HTTP Basic -> 200; 3 products
GET wc/v3/products over http with HTTP Basic -> 401; {"code":"woocommerce_rest_cannot_view","message":"Sorry, you cannot list resources.","data":{"status":401}}
GET wc/v3/products over http with OAuth 1.0a signature -> 200; 3 products
  wp_woocommerce_api_keys row: 2 | Agentify - API (2026-09-14 06:54:30) | read_write | c33995b
```

The keys work. The `read_write` scope asked for is the scope stored, and the
key is visible to the merchant afterwards at WooCommerce → Settings → Advanced
→ REST API, under the application name we supplied:

```
Agentify - API (2026-09-14 06:54:30)    c33995b    Read/Write
```

### 2. Store API without authentication — PASS

```
GET http://localhost:8088/wp-json/wc/store/v1/products (no Authorization header, no cookie) -> 200
  3 products, response was 10345 bytes
  id=12 sku=agentify-abonement name="Абонемент на месяц" price=12000 USD type=simple description=863 chars
  id=11 sku=agentify-tote name="Canvas tote bag" price=2500 USD type=simple description=56 chars
  id=10 sku=agentify-access-code name="Access code" price=500 USD type=simple description=51 chars
  all three seeded SKUs present
```

No configuration was needed for this. Note that the Store API reports prices as
strings of minor units, with the scale alongside them — not as the decimal
strings `wc/v3` returns for the same product:

```
"prices": { "price": "12000", "regular_price": "12000", "currency_code": "USD",
            "currency_minor_unit": 2, "currency_symbol": "$", … }
```

A converter that reads `price` without reading `currency_minor_unit` is wrong
by a factor of a hundred, quietly, for every ordinary currency.

### 3. Paid order created from outside — PASS

```
POST wc/v3/orders (set_paid:true) -> 201
  response: id=13 number=13 status=processing total=5.00 USD date_paid=2026-09-14T06:54:32 transaction_id=probe-tx-0001
  wp wc shop_order get 13: status,processing
  wp wc shop_order get 13: payment_method,agentify
  wp wc shop_order get 13: transaction_id,probe-tx-0001
  wp wc shop_order get 13: date_paid,2026-09-14T06:54:32
  order storage: woocommerce_custom_orders_table_enabled=no
  raw storage row: 13 | shop_order | wc-processing
  wp-admin orders screen -> 200; order #13 listed: true; status class shown: processing
  mail attempted: to="admin@example.test" subject="[Agentify WooCommerce probe stand]: New order #13"
  mail failed: to=["admin@example.test"] subject="…" reason=Could not instantiate mail function.
  mail attempted: to="buyer@example.test" subject="Your Agentify WooCommerce probe stand order has been received!"
  mail failed: to=["buyer@example.test"] subject="…" reason=Could not instantiate mail function.
```

The order is asked about four times and agrees with itself every time: in the
REST response, through WooCommerce's own object layer over WP-CLI, in raw
storage, and on the orders screen a human would open in wp-admin.

`payment_method: "agentify"` is accepted although no gateway by that name is
installed — WooCommerce stores the string without checking it. The
`transaction_id` we supplied is stored and shown.

**Side effects.** Creating the order sent WooCommerce looking for two emails:
one to the shop administrator ("New order #13") and one to the buyer ("Your …
order has been received!"). Both failed here only because the container has no
mail transport. On a merchant's real shop they would go out. Nothing in the
request asked for them and nothing offered to suppress them.

## What was surprising

**The approve control is a link, not a form.** The grant is completed by a
`GET` on a nonce-carrying URL (`wc_auth_nonce`), not by a form POST. Anything
that automates or tests this flow is following a link.

**`callback_url` must be https, and the shop itself need not be.** The
authorize endpoint was reached over plain http throughout and did not care.
The callback is a different matter, and a `callback_url` with no scheme is
silently promoted to `https://` rather than refused:

```
callback_url=http%3A%2F%2Fcallback%2Fwc-auth-callback
  -> Error: The callback_url needs to be over SSL.
callback_url=callback%2Fwc-auth-callback
  -> 302, and the shop's own redirect now reads callback_url=https%3A%2F%2Fcallback%2Fwc-auth-callback
```

**`user_id` and `callback_url` are mandatory, not optional.** The five required
parameters are `app_name`, `user_id`, `return_url`, `callback_url` and `scope`.
Omitting any one produces `401` and `Error: Missing parameter <name>.` There is
no default for `user_id`; it is an opaque string the application chooses to
identify the merchant to itself, and it comes back in both the callback payload
and the return redirect.

**Plain permalinks break the flow silently — this is the sharp edge.** With
`permalink_structure` empty, `/wc-auth/v1/authorize` does not error. It
redirects once and serves the shop's ordinary front page with `200`:

```
=== with pretty permalinks:   302   (on to /wc-auth/v1/login/)
=== with plain permalinks:    301 -> …/wc-auth/v1/authorize/?…  then 200
    <title>Agentify WooCommerce probe stand</title>
```

A merchant whose shop uses plain permalinks would click Connect, land on their
own homepage, and have nothing to report except that it did not work. No error
text, no 404, nothing in a log.

**WooCommerce picks its REST authentication scheme from `is_ssl()`.** Over
https the granted key and secret go in as HTTP Basic. Over plain http, Basic is
refused with `woocommerce_rest_cannot_view` — a message about permissions that
says nothing about the real cause — and the request must instead carry an
OAuth 1.0a one-legged signature in the query string. Both were exercised on this
stand and both returned `200` with the same key pair. The signing algorithm has
a quirk worth knowing if it is ever needed: each `key=value` pair is
percent-encoded **twice** before being joined
(`class-wc-rest-authentication.php`, `join_with_equals_sign`).

**High-performance order storage is off.** A WP-CLI install of WooCommerce 11.1
leaves `woocommerce_custom_orders_table_enabled` at `no`, so orders are still
posts in `wp_posts`. This changes nothing for anyone using the REST API, and
everything for anyone reading the database directly.

**Two things had to be arranged that a real merchant never faces**, both
because the whole stand is on one laptop, and both gated behind a flag file so
the probes record what a stock shop does first:

- `wp_safe_remote_post` refuses a URL that resolves to a private address, and
  the callback receiver sits on the compose network at 172.x. The stock attempt
  is recorded in the probe output as `Approve on a stock shop -> 401; "Error: A
  valid URL was not provided."` with the shop's own outbound log showing `POST
  false -> http_request_failed`.
- The receiver's certificate is self-signed, and WordPress verifies outbound
  TLS against its bundled CA list. The instrument points verification at the
  stand's certificate rather than switching it off, so a wrong certificate
  still fails.

The same rule that blocks private addresses also restricts outbound ports to
80, 443 and 8080 (`wp_http_validate_url`), which is why the receiver listens on
443 inside the network rather than something higher. That one is not
laptop-specific: **our callback endpoint has to be on 443.**

Finally, a refused grant leaves nothing behind. wc-auth writes the key row
before it posts and deletes it again if the post fails (`maybe_delete_key`), so
a merchant who half-completes a Connect does not accumulate dead keys.
