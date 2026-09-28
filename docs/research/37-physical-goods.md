# Physical goods: what the asynchronous path carries, and what shops do

Date: 2026-09-28. A research note that may be rewritten. It supports ADR-0031
(the buyer's address) and ADR-0032 (a shipped order ends at the carrier), and
it is where their field names come from once they are fixed. The pilot has no merchant who sells
parcels; Dmitry's word of the same day is to lay the foundation anyway, far
enough for a demonstration, because merchants will not come to a path that
does not exist.

## The asynchronous path as it stands

A card that says `fulfillment: 'async'` is sold in this order. The merchant's
price check, when the card has one, is asked before any money moves and
receives the purchase parameters (`apps/docs/examples/quote-request/`); when it
is silent the asynchronous mode does not sell at all
(`packages/core/src/orders/machine.ts`, `sellsOnSilentQuote`). The agent pays,
the gateway verifies and settles the payment inside the purchase request, and
the agent receives `200` with `in_progress` and a `status_url` — with no
deadline, no expected time and no transaction hash. The order goes to the
merchant's subscription; the handler has three seconds to answer
(`HANDLER_ANSWER_MS`) before the delivery counts as lost and is repeated, up to
five attempts. The handler takes the order on with `accepted`, whose
`eta_seconds` the gateway discards (`apps/gateway/src/app/gateway.ts`,
`#takeOrderOn`). Later `order.deliver(result)` closes the order as `delivered`
and writes the receipt, dated back to the charge. A second `deliver` answers
success and keeps nothing.

The clock is `async_fulfillment`, counted from the charge
(`packages/core/src/orders/deadlines.ts`). The card may name it as
`fulfill_deadline_seconds`, a positive integer with no ceiling; a card that
does not is held to a day the agent is never shown. When the clock runs out,
or the merchant refuses after the charge, the order becomes `refund_due` and
the merchant is sent one event, which is never sent again. Goods delivered
late settle the debt (ADR-0028). The command that would record a refund is not
built, so nothing reaches `refunded`. The agent learns any of this only by
polling `status_url`, where holding the order identifier is the proof
(ADR-0011).

The confirmation mode, where the money moves only after the merchant's yes, is
complete inside the machine and closed at the card door and in the gateway's
executor (ADR-0007). Its agent side — how the agent is told it may now pay — is
not designed.

## Where a parcel does not fit

The machine itself needs almost nothing. What does not fit is everything that
assumes the goods are a flat JSON object that reaches the agent the instant it
is handed over.

The address has nowhere of its own to go. The only carrier is `params`: flat
scalar fields the merchant declares, with no format, length or sensitivity. They
are stored in `orders.record` from the unpaid request on, including orders that
never get paid, copied into every order and price-question envelope, kept by
pg-boss for seven days after an envelope is completed (its queue default,
`deletion_seconds`), and in the nightly backups for thirty days. Nothing deletes
an order. ADR-0031 answers this.

`delivered` claims more than a merchant who shipped can know. It means the goods
are with the agent; for a parcel the merchant knows only that a carrier took it.
The call that records goods is once only, so a tracking update after it is
silently ignored, and there is no path from `delivered` back to a debt for a
parcel lost on the way. ADR-0032 answers this.

The money back is decided and not built. ADR-0028 chose that late goods settle
a debt until a refund is recorded, and none of its three pieces exists: the
operator's command, the operator's pause, the merchant's view of the payer's
address. For digital goods a refund owed is rare; for parcels it is an ordinary
ending (the stock the shop system showed was not on the shelf). This is why a
`ship` card stays off the live channel until the command exists.

The rest is smaller. The three-second answer budget is not named on the portal,
and a handler that books a courier inside it spends its five attempts in about
a minute; the answer is to take the order on at once and work outside the
handler, which the demonstration merchant already does. A card is one item at
one price: no quantity, no variants, no line for shipping, so the shipping cost
is part of the price the price check answers. The price check's "unavailable"
carries no reason, so "we do not ship there" and "out of stock" are one bare
`rejected` to the agent. The public card has no shape for the seller's identity
or contact (`packages/contracts/src/card.ts`, the public card's description), so
after shipment the agent would not know whom to ask; the shipment record
carries it.

## How the scope was narrowed

Physical goods were in the first hypothesis — «виртуальные или физические
товары и услуги» (`01-hypothesis.md`) — and the first merchant contract offered
three ways to hand over goods: the merchant's API, a paid order in the
merchant's shop, a message the merchant confirms by hand
(`05-merchant-contract.md`). Freeland was chosen as the pilot precisely because
it has «ни логистики, ни склада» (`03-freeland-pilot.md`). The adversarial
review of the vision found that a physical product has no address mechanics at
all (`09-adversarial-review.md`); the second vision moved physical goods behind
«механики адреса» and sketched the delivery token that ADR-0031 rejects
(`08-product-vision-stories.md`). The open question stayed open
(`00-open-questions.md`) until ADR-0031. The WooCommerce connector imports only
virtual, downloadable products and refuses the rest with «Only virtual products
can be delivered to an agent without a shipping address»
(`apps/cabinet/src/woo-catalog.ts`, ADR-0023).

## Protocols and marketplaces

Read on 2026-09-28: the Agentic Commerce Protocol at its release `2026-04-17`
(github.com/agentic-commerce-protocol), the Universal Commerce Protocol at tag
`v2026-08-25` (github.com/Universal-Commerce-Protocol/ucp), the Shopify Admin
API `2026-07`, schema.org V30.1, the x402 repository now at
`x402-foundation/x402`, and the public seller rules of Amazon and eBay. Amazon's
guarantee text came through a search snippet because the page itself answered
503, so it is worth reading again before it is quoted anywhere else.

The word for "handed to a carrier" is `shipped` wherever there is one. ACP's
order status defines it as «All items handed to carrier», and its line-item
`fulfilled` means dispatched rather than received; UCP's fulfilment event
`shipped` reads «handed to carrier»; Amazon's order status ends at `Shipped`;
Shopify calls the same moment `FULFILLED` and tracks delivery separately, as
shipment events. schema.org has no such word — its statuses go from
`OrderProcessing` to `OrderInTransit` and `OrderDelivered`. No specification
treats `shipped` as the last word: ACP expects `completed` once the goods are
received, and UCP's events continue to `in_transit` and `delivered`. So the
"nothing further is known to us" in ADR-0032 is ours and has to be said in the
status's own description, not left to the word.

The shipment itself is named the same way almost everywhere: `carrier`,
`tracking_number`, `tracking_url` in ACP, UCP and WooCommerce's own
fulfilments, `company`, `number`, `url` in Shopify's `tracking_info`, and
`provider`, `trackingNumber`, `trackingUrl` in schema.org. ACP puts where the
buyer asks in a `support` object of `email`, `phone` and `help_center_url`.
UCP requires a tracking number and address on every event past `processing`,
and the marketplaces measure sellers by it: Amazon by its valid tracking rate,
eBay by a carrier's acceptance scan inside the handling time, which is what
protects a seller against a claim that the parcel never arrived. Every
specification also carries an expected delivery window — ACP's
`estimated_delivery` with `earliest` and `latest`, schema.org's
`expectedArrivalFrom` and `expectedArrivalUntil` — and both marketplaces start
the buyer's "not received" claim from the latest estimated delivery date
(Amazon adds three days; eBay allows thirty days from it).

The time to ship is a named, separate promise. Amazon's order carries
`LatestShipDate` beside `LatestDeliveryDate`; eBay's handling time begins at
payment and ends at the carrier's scan. That is the clock ADR-0032 puts on the
card as `fulfill_deadline_seconds`.

On the address, every source spells the country as ISO 3166-1 alpha-2. They
disagree on nearly everything else:

| | ACP | UCP | Shopify | schema.org | WooCommerce | Stripe |
| --- | --- | --- | --- | --- | --- | --- |
| recipient | `name` | `first_name`, `last_name` | `firstName`, `lastName` | — | `first_name`, `last_name` | `name` |
| lines | `line_one`, `line_two` | `street_address`, `extended_address` | `address1`, `address2` | `streetAddress`, `extendedAddress` | `address_1`, `address_2` | `line1`, `line2` |
| city | `city` | `address_locality` | `city` | `addressLocality` | `city` | `city` |
| region | `state` (a code) | `address_region` | `provinceCode` | `addressRegion` | `state` | `state` |
| postal code | `postal_code` | `postal_code` | `zip` | `postalCode` | `postcode` | `postal_code` |
| country | `country` | `address_country` | `countryCodeV2` | `addressCountry` | `country` | `country` |
| phone | `phone_number`, beside the address | `phone_number` | `phone` | — | `phone` | `phone` |

ACP's is the one address an agent already writes in snake case, and an agent
holding an ACP address could pass it through unchanged. ACP requires the region
and the postal code everywhere; UCP says the region is required only where the
country has one, which is the truer rule.

Two findings bear directly on ADR-0031. UCP names the very thing its price
check does: a buyer's context before the purchase «SHOULD be non-identifying
and can be disclosed progressively — coarse signals early, finer resolution as
the session progresses», with `address_country`, `address_region` and
`postal_code` as the coarse signal. But it also says that eligibility «MUST
occur at checkout time using binding transaction data», and ACP, UCP and both
intermediaries that sell parcels over x402 today (Rye with AgentCash, and
Crossmint) show the merchant the full address before the money moves. A
purchase here is priced at the moment of purchase, which is checkout, so the
coarse-only price check is stricter than the practice: a street the merchant
cannot deliver to surfaces only after the charge, as a refund owed. And on
keeping the address, ACP asks only that addresses be redacted «as required by
policy», UCP lets a business apply retention windows and regulatory erasure,
and Amazon lets its integrators keep an address for thirty days after
delivery. Erasing at acceptance is well inside all of them, and it gives up
what eBay uses to settle a claim — that the address shipped to matches the
order's.

x402 itself has no convention for addresses or shipping: its extensions cover
the catalogue, identity, gas and receipts, and a search of the repository finds
nothing about physical goods. Physical goods over x402 today go through
intermediaries that take the full address before quoting — Rye's buyer object
is `firstName`, `lastName`, `address1`, `address2`, `city`, `province`,
`country`, `postalCode`, Crossmint's is `name`, `line1`, `line2`, `city`,
`state`, `postalCode`, `country` — and neither publishes a rule on keeping it.

## WooCommerce

Read from WooCommerce's source at commit `943172b` of trunk (11.3.0-dev,
2026-09-25), with paths below relative to `plugins/woocommerce/`, and from its
published documentation. Nothing here was tried against a running shop.
WooCommerce is not the goal; it is the shop software a large share of small
merchants run, and so the nearest reading of what they already expect.

An order's shipping address has `first_name`, `last_name`, `company`,
`address_1`, `address_2`, `city`, `state`, `postcode`, `country` and, since
5.6, `phone`, which the order keeps and the REST schema does not document
(`includes/class-wc-order.php`). The REST API requires none of them. Which are
required is decided per country at checkout (`WC_Countries::get_country_locale`),
and that table reaches a client only as settings embedded in the checkout
page; postal-code patterns exist for thirty-three countries, and any code is
accepted for the rest (`includes/class-wc-validation.php`).

Shipping cost is drawn from a zone, and a zone matches on the country, the
country and state, the continent, or a postal-code pattern
(`includes/data-stores/class-wc-shipping-zone-data-store.php`). So a price drawn
from the country and the postal code alone is wrong for a shop whose zones are
states, and a shop that hides shipping costs until the address is "full" — the
country with the city, state and postal code its locale requires — shows no
rate at all (`src/Blocks/Shipping/ShippingController.php`). That is why ADR-0031
gives the price check the locality of four fields and not two. No REST endpoint
calculates a rate. A client without a browser gets one through the Store API's
cart: read the cart for a `Cart-Token`, add the item, set the customer's
shipping address, and read `shipping_rates` from the answer
(`src/StoreApi/Routes/V1/AbstractCartRoute.php`). Every such question leaves a
guest session in the shop, and several rates can come back.

A paid order is created as the connector already creates one for downloads,
with `set_paid` and the merchant's own address in `billing`, so none of the
shop's customer emails reaches the buyer; for a parcel it also carries the
`shipping` block and a `shipping_lines` entry, whose `method_id` is required
(`includes/rest-api/Controllers/Version2/class-wc-rest-orders-v2-controller.php`).
Paying moves an order with anything not both virtual and downloadable to
`processing`, reduces stock, and does not check stock first. A shop that
forces shipping to the billing address, or has shipping switched off, would
drop the address from the merchant's own screens and has to be refused.

WooCommerce has no "shipped". `processing` means paid and awaiting
fulfilment, and `completed` means «fulfilled and complete… Requires no further
action», which merchants use for shipped and sometimes for delivered. Tracking
lives in two places: the core «Order Fulfillments» (a fulfilment with
`_tracking_number`, `_shipment_provider` and `_tracking_url`, at
`wc/v3/orders/{id}/fulfillments`), present since 10.1 and switched off by
default in every release so far (`src/Internal/Features/FeaturesController.php`);
and the paid Shipment Tracking extension, with `tracking_provider`,
`tracking_number`, `tracking_link` and `date_shipped`. A connector would read
the first where it exists and the second otherwise, and learn of shipment by
polling the order with `_fields` that leave the address out, or from the webhook
topic `action.woocommerce_order_status_completed`, whose payload is the order's
number and nothing else. The `order.updated` topic carries the whole order,
address included. Returns do not exist in core; a lost parcel is a refund or a
new order, and a refund on an order Agentify created needs `api_refund: false`.

WooCommerce's own answer to keeping an address is to anonymise the order on a
timer the merchant sets, blank by default: names, lines, city and postal code
become «[deleted]», and the state and the country become empty strings
(`includes/class-wc-privacy.php`, `includes/class-wc-privacy-erasers.php`). It
keeps nothing of the address, which is what ADR-0031 does from the start.

So a connector can carry physical simple products. The address maps one to one
(`name` goes whole into `first_name`, because splitting it would be a guess);
the paid order, the silent billing and the shipping line are what the
connector already does; `shipped` is `completed` or a fulfilled fulfilment.
What does not map cleanly is the rate, which needs the cart exchange, and
whose chosen method and price have to be bound to the price identifier; the
several places tracking may live; and the shop's own echo of the address in
every answer, which the connector must neither keep nor log. Variable products
would be one card per variation, or none.

## The names this note fixes

`ship_to` takes the Agentic Commerce Protocol's names, because that is the
address an agent already writes: `name`, `line_one`, `line_two`, `city`,
`state`, `postal_code`, `country`, `phone_number`. `country` is ISO 3166-1
alpha-2; `state` is the subdivision code without the country prefix where the
country has one. A single `name` holds a person with one name, which many
people have, and a split name cannot be recovered from it without guessing.
`company` is left out: the second line holds it.

The shipment record takes the names ACP, UCP and WooCommerce share: `carrier`,
`tracking_number`, `tracking_url`, `estimated_delivery` with `earliest` and
`latest`, and ACP's `support` with `email`, `phone` and `help_center_url`. The
moment of shipment is the gateway's to stamp, not the merchant's to write.

## Open
- A reason on the price check's "unavailable", so that "not to this
  destination" and "out of stock" are two answers to the agent.
- The ceiling on the time to ship, and its number.
- Whether the rest of `params` should follow the address's retention.
- How the operator learns that a shipped parcel was lost, once the ADR-0028
  command exists.
