# Physical goods: what the asynchronous path carries, and what shops do

Date: 2026-09-28. A research note that may be rewritten. It supports ADR-0031
(the buyer's address), ADR-0032 (a shipped order ends at the carrier) and
ADR-0033 (the seller's name and site), and records how their field names were
chosen; the names themselves are fixed in the decisions. The pilot has no
merchant who sells parcels; the product owner's word is to lay the foundation
anyway, far enough for a demonstration, because merchants will not come to a
path that does not exist.

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

The machine itself needs little: one switch on its mode and one edge, both
for the lost parcel (ADR-0032). What does not fit is everything that assumes
the goods are a flat JSON object that reaches the agent the instant it is
handed over.

The address has nowhere of its own to go. The only carrier is `params`: flat
scalar fields the merchant declares, with no format, length or sensitivity. They
are stored in `orders.record` from the unpaid request on, including orders that
never get paid, and the merchant can read them back on those too
(`list_orders` keeps every priced order). They are copied into every order and
price-question envelope, kept by pg-boss for seven days after an envelope is
completed (its queue default, `deletion_seconds`), and dumped with the database
every ten minutes into snapshots that live up to thirty days, their deleted
copies thirty more (ADR-0029). The driver's error for a failed statement
carries every bound parameter, and only the path that first writes an order
strips it (`apps/gateway/src/adapters/postgres/store.ts`). Nothing deletes an
order. ADR-0031 answers this.

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
the agent would not know whom to ask about a parcel; ADR-0033 gives it the
shop's own site.

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
card as `ship_within_seconds`.

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
required is decided per country at checkout
(`WC_Countries::get_country_locale`), and that table reaches a client only as
settings embedded in the checkout page; postal-code patterns exist for
thirty-three countries, and any code is accepted for the rest
(`includes/class-wc-validation.php`).

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
`processing`, reduces stock, and does not check stock first. A shop that forces
shipping to the billing address, or has shipping switched off, would drop the
address from the merchant's own screens and has to be refused.

WooCommerce has no "shipped". `processing` means paid and awaiting fulfilment,
and `completed` means «fulfilled and complete… Requires no further action»,
which merchants use for shipped and sometimes for delivered. Tracking lives in
two places: the core «Order Fulfillments» (a fulfilment with
`_tracking_number`, `_shipment_provider` and `_tracking_url`, at
`wc/v3/orders/{id}/fulfillments`), present since 10.1 and switched off by
default in every release so far
(`src/Internal/Features/FeaturesController.php`); and the paid Shipment
Tracking extension, with `tracking_provider`, `tracking_number`,
`tracking_link` and `date_shipped`. A connector would read the first where it
exists and the second otherwise, and learn of shipment by polling the order
with `_fields` that leave the address out, or from the webhook topic
`action.woocommerce_order_status_completed`, whose payload is the order's
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
`company` is left out: the second line holds it. The phone number is required,
because the carriers a merchant hands a parcel to mostly ask for one and the
merchant cannot ask for it themselves.

The shipment record takes the names ACP, UCP and WooCommerce share: `carrier`,
`tracking_number`, `tracking_url`, and `estimated_delivery` with `earliest` and
`latest`. The carrier is required, as a short plain-text string with no list
behind it; `tracking_number` is a required key whose `null` says the parcel has
none, so "none" is never an empty field. The agent reads the record in a
`shipment` field of its status document, beside an absolute `ship_by`. The
moment of shipment is the gateway's to stamp, not the merchant's to write.
Where the buyer asks is the shop's own site, read with the seller's name as a
`seller` object (ADR-0033), not part of each shipment. The card's time to ship
is `ship_within_seconds`, a name of its own, because on an asynchronous card
`fulfill_deadline_seconds` means the time to deliver, and a number read under
the wrong name tells a person their parcel arrives when it merely leaves.

## The adversarial review

Two reviewers read the first drafts of ADR-0031 and ADR-0032 against the code
on 2026-09-28, one for the logic, the money, the personal data and the
reliability, the other for what the buying agent and the merchant's engineer
meet and for the charter. The decisions were revised the same day; what
follows is what they found and what became of it.

The erasure was underspecified in a way that cost money. Rewriting the queued
envelopes instead of deleting them would let a redelivery that was already
waiting reach the handler without an address after the merchant had taken the
order on, and a handler that failed on it would spend its attempts into a
refund owed while the parcel was being packed. Erasing now deletes every
envelope of the order, waiting, drawn or failed. The merchant's reads showed
the address of orders that were only priced, which contradicted "only in a paid
order"; now only a paid order shows it, and an erased one says `erased_at`
rather than going quiet. "Never written to a log" was false on today's error
paths, where the driver's message carries the whole order; it stays a rule, and
building it means stripping those errors and a test that fails a write of an
order holding a sentinel address and searches the logs for it. The backup
facts were stale (a dump every ten minutes, not nightly), and "ours for
seconds" held only while the merchant's worker runs; both were corrected. A
paid request that carried a different address was silently ignored, because a
payment naming an order never reads the body; it is now refused before the
payment is verified.

The lost parcel's way back was wrong as drafted. Reopening a shipped order into
a refund owed would put it back on the merchant's list of open orders, where a
stale delivery of the lost parcel's record closes the debt with nothing sent,
and the lost tracking number would be the one kept. The command of ADR-0028 now
records a refund on a shipped order directly, and a replacement parcel is the
merchant's business. The status word and the receipt had to come from the
order, not the card, because a card republished from `ship` to `async` would
otherwise change the words of orders in flight; the order records at purchase
that it is a parcel. The receipt reads `shipped` as well.

The storefront has no version (ADR-0006 §5), and its catalogue and status are
closed lists that a client generated from the contract parses strictly. A first
`ship` card would have broken such a client's whole catalogue, and a `shipped`
it could not read might have sent it to buy again. ADR-0006 §5 now says those
vocabularies are open and how an agent treats a value it does not know. The
discovery listing an agent finds in a catalogue carries only the input schema
built from `params` and an example output built from `result`, so it would
have said nothing about the address or the shipment; ADR-0032 now puts both in
it, with a real address as the example — invented ones fail the published
examples' own test and the charter. The agent also had no way to know when to
stop polling a parcel that had not left, so the order's status carries the
absolute `ship_by`.

Several smaller changes followed from the same reading. The ceiling on the time
to ship moved from the deployment's configuration into the contract, beside the
price rule, where the offline card check sees it. The time to ship took a name
of its own. The required price check has to be the handler, because a card
naming a price hook that nothing calls would publish and never sell. The
contact moved from each shipment to the merchant, because a buyer needs it
before shipment and on a refund owed too; the product owner then took it out of
our scope altogether, and the agent is given the shop's own site instead
(ADR-0033). Tracking stayed required after the review, said at the door rather
than first met at `deliver` after the charge; the case of a coffee sent by
courier then showed that a local courier has no number to give, and it became
optional (see the decisions below). The phone number became required and
`state` was named a subdivision code. The per-country table of required fields
was dropped rather than sourced: the door checks the shape, and the merchant's
price check judges the geography before money moves. The decisions that the new
ones amend — ADR-0002 §3, ADR-0006 §5, ADR-0007 §5, ADR-0011 and ADR-0028 —
were edited in the same change.

A second round read the revisions against the code. It confirmed most of
them and found five more things. The open vocabularies had been written only as
words on closed schemas, so a `ship` card still broke a strict catalogue;
ADR-0006 §5 now makes the storefront's mode and status open strings, reads the
catalogue card by card, and says why §3's rejection of an open string does not
reach a surface with no version. Recording a refund on a shipped order is an
edge out of the machine's closed `delivered`, readable only if the mode knows
the goods are a parcel; ADR-0032 now says the mode gains that switch, instead
of claiming the machine was untouched. A refunded parcel's receipt would still
have read `shipped`, and now reads the refund. An envelope drawn just before
erasure could still be redelivered from the erased order; an erased order is
now never handed out again. And a merchant admitting a lost parcel could not
see whom to pay back, so ADR-0028's view of the payer covers a shipped order,
and the live gate names every piece it waits for. The revisions were then put
up for acceptance one at a time.

One finding was kept against. The second reviewer proposed erasing at shipment,
so that a merchant who stored only our order identifier — as the portal's
asynchronous pattern teaches — could read the address back. That would hold
every address through days of handling, which the product owner decided against.
The address is erased when the order is taken on, and the portal's pattern and
its restart walk change for parcels instead. Another was recorded rather than
fixed: a handler slow on every attempt exhausts five of them in about twenty
seconds, and the order closes as a refund owed labelled with a passed deadline
the agent was told was days away. That is true of the asynchronous mode today
and is listed below.

## What a merchant's engineer learns

The count is the price of the mode, and it is paid once per integrator: the
value `ship`; `ship_within_seconds`, required and under a ceiling; a price
check that must be the handler, and receives the locality; the `ship_to` block
on the order, present only once paid and read as `erased_at` once erased; the
rule that taking an order on means the address is stored; the shop's site named
once in the cabinet (ADR-0033); the card without a `result`; `deliver` carrying
the shipment, with the carrier required and the tracking number where there is
one; the status word `shipped`, on orders and receipts; a contract version that
moves; and the refusal of a `ship` card on the live channel, with its reason.

## What changes when it is built

The machine: a third switch on the order's mode, and the one edge from
`delivered` to `refunded` for a parcel, with the descriptions of `refunded` —
today every one of them says a debt was closed, and a shipped order never had
one. The contract: the card's fulfillment values and its public projection, the
purchase request, the order and its merchant document, the price question, the
status vocabulary and the agent's status document with `ship_by`, the seller's
name and site on cards and orders, the storefront's mode and status carried as
open strings with the catalogue read card by card, the receipt's outcome, the
descriptions of `rejected` and of the field that carries what the merchant
handed over, and the contract version. The gateway: the door checks, the
erasure and its test, an erased order never handed out again, the stripped
errors, the refusal of a changed address at payment, the refusal on the live
channel, and — when ADR-0028 is built — the receipt of a refunded parcel and
the payer's address on a shipped order. The SDK's types. The discovery
declaration. The cabinet's field for the site. The portal: the cards page (the
mode, the time to ship, the site, the carrier and optional tracking, what the
card's price means), the orders page (the mode's sequence, the endings table
that the machine's tests read, acceptance storing the address, the restart
walk), the quickstart's asynchronous pattern, the money page, and the FAQ's
dispute answer, which promises records of what happened with the delivery that
for a parcel we do not keep. `apps/docs/index.md`'s pilot rule, when the live
gate opens.

## Decisions of 2026-09-28

The demonstration sells a product made for it in the test WooCommerce shop the
lab keeps (`deploy/woocommerce-lab/`), and the product owner buys it on the
test channel with their own address: a real product, a real address given with
consent, and nobody hurt if something goes wrong. So the path the
demonstration walks is the shop connector's, and the connector learns to carry
a physical simple product as part of the build, with ADR-0023 edited in the
same change. The SDK path comes first all the same, because the connector is a
handler written against the same contract. The address stays in the test
shop's own order until the lab is reset or anonymises it, since the shop, and
so the merchant, is ours there.

The ceiling on the time to ship is thirty days, `ship_within_seconds` of at
most 2 592 000. It bounds how long a buyer's money can sit with a merchant
before the order becomes a refund owed, and it is the ceiling the marketplaces
already give sellers: Amazon's default maximum handling time is thirty days,
longer only for a few product types
(github.com/amzn/selling-partner-api-samples, discussion 124), and eBay's has
been thirty business days, recently forty (eBay community, «40 days now showing
on handling time»). The product owner confirmed the number with the other
revisions; it moves on their word once a real merchant needs another.

A handler that runs out of attempts, and the label its order closes under, stay
as they are, to be adjusted if they turn out to hurt. Duties — where the
recipient pays them, the price the agent paid is not the whole cost —
restricted goods, which nothing here can check an age for, returns, a changed
or mistyped address and pickup points are not worked on for now. ADR-0032 names
them as outside the mode.

The product owner then accepted the revisions of the two review rounds one at a
time. The price question carries the locality — country, state, city and postal
code — rather than the country and postal code alone. A lost parcel is a refund
recorded on the shipped order, which becomes `refunded`, rather than a shipped
order reopened into a refund owed. Where a buyer asks is not a contact Agentify
keeps: the product owner doubted that one is needed at all, since it would
bring more scope into the product, and the agent is given the shop's site and
the seller's name, with nothing else about the merchant (ADR-0033). A tracking
number is not required: a coffee sent across town by the shop's courier has
none, and a required one would shut such shops out or be filled with something
made up. The carrier is required as a short free string of plain text, and a
shipment without a number says so. The storefront's vocabularies and documents
are open to agents, the merchant's stay strict. The worry that came with that
choice — drowning in versions at a stage this early — is met by what the choice
already does and by one practice: the agent's side has no version at all, and
the SDK's contract version moves once per feature released, not once per field,
so the whole parcel mode is a single move.

The decisions themselves were then held to the charter's length. What left them
is the mechanics this note already carries — which envelopes, which error
paths, which pages — and no rule or reason.

## The pull request's review

The decisions went into one pull request with the pass that took a person's
name out of the records, and two readers read it, one for the logic, the
security, the tests and the reliability, the other for the words and the
merchant's path. Their findings changed the decisions once more.

The names an agent reads moved from this note into the decisions: the
storefront has no version, so a name shipped there can never be renamed, and a
name that cannot be renamed is a decision. ADR-0032 now fixes the ceiling of
2 592 000 seconds, `ship_by`, the `shipment` field beside an empty `delivered`,
and a `tracking_number` that is a string or `null`; ADR-0031 fixes the
locality as a `ship_to` of four fields; ADR-0033 fixes the `seller` object.
ADR-0031 had read as though erasure deleted the refund-owed notice, which is
sent once and never again; it now deletes only the envelopes that carry the
order's document. It also says as an instruction, not a consequence, that the
handler stores the address before answering `accepted`. ADR-0032 says what a
`ship` card may and may not carry, that the price check's answer is the whole
price with shipping and the card's own price the goods without it, that a
second, different shipment is refused with words rather than swallowed, what
`rejected` can mean on a parcel, and that the contract version's move stops
every older worker. Its live gate gained one condition: a merchant who admits a
parcel lost had no way to reach the operator, because the operator makes
contact only on a refund owed, and a shipped order never becomes one; the
cabinet now has to say how. ADR-0033, written after the second review round,
took its first review here: a merchant-written address with a path or a query
would carry free text to every agent, so only an `https` origin is taken, and
the seller name is held to the plain-text rule.

The pass over the records had removed not only the name but, in places, who
decided. A reader has to know which decisions rest on the product owner's word,
because that word is what it takes to reverse them, so the records now name
the role wherever the person had been the decider, and the charter says once
what the role is.

## Open

- A reason on the price check's "unavailable", so that "not to this
  destination" and "out of stock" are two answers to the agent.
- Whether the rest of `params` should follow the address's retention.
- The connector's rate is three or four calls to the shop's Store API inside
  the price check's five seconds, and each leaves the locality in a guest
  session there.
