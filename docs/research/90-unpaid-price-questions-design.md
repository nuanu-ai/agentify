# Unpaid price questions: the design agreed on 2026-10-27

This note records the design the product owner agreed in a working session on
2026-10-27 for the problem that
[87-unpaid-price-questions](87-unpaid-price-questions.md) describes and that
[ADR-0043](../decisions/0043-the-purchase-door-refuses-before-any-charge.md)
leaves open: anybody can keep fifty of a merchant's purchases priced and
unpaid, pay for none, and so stop that merchant's sales through Agentify for
nothing. It is the reasoning behind the coming edit of ADR-0043 and ADR-0048,
with every alternative that was weighed, its source and why it lost. Nothing
here is built yet. Where a sentence says the product owner decided something,
it is his word of that day; everything else is an engineering consequence and
says so.

## What holds what today

Three things are held for a request nobody paid for.

The first is the order itself. An unpaid purchase writes its order before the
merchant is asked the price (`runner.create` with `waitingAtMost` in
`apps/gateway/src/app/gateway.ts`), and that order counts against the fifty for
up to thirty-five seconds: five to wait for the merchant's answer
(`QUOTE_RESPONSE_MS`) and thirty for the price to hold (`QUOTE_TTL_MS`). The
row then stays for thirty days until ADR-0048's clean-up deletes it. By my
arithmetic, one script sending about one and a half requests a second keeps a
merchant's sales stopped for as long as it runs.

The second is the merchant's queue. A price question travels to the merchant
as a durable pg-boss job on the same per-merchant stream as the hand-overs of
paid orders, in order of arrival, and both the SDK's process and the
WooCommerce connector take at most four pieces of work at once
([83-worker-throughput](83-worker-throughput.md)). A stream of price questions
therefore delays orders that have already been paid for.

The third is left at the merchant. The connector prices a parcel by opening a
fresh guest cart in the shop for every question (`shippingRatesInTheShop` in
`apps/dashboard/src/woo-shop.ts`), and WooCommerce keeps that cart, with the
destination in it, for two days. The SDK documentation (`apps/docs/cards.md`)
allows a merchant to set stock aside against a price until it expires. A free
question that reserves stock is a known class of abuse, which OWASP lists as
Denial of Inventory, OAT-021
([OWASP Automated Threats](https://owasp.org/www-project-automated-threats-to-web-applications/)).

## The principle

A request nobody paid for may use a moment of a merchant's capacity and holds
nothing over time: no place in a limit, no row, no stock and no session in the
shop. Whatever is held begins at the payment. Work that is paid for never
waits behind work that is not. The product owner added the rule that a slow or
overloaded merchant must never affect any other merchant.

The same idea protects TCP servers from half-open connections: with SYN
cookies the server keeps nothing for a connection that has not completed its
handshake, and the state it needs travels with the client and comes back with
the acknowledgement ([RFC 4987](https://www.rfc-editor.org/rfc/rfc4987)).

## The decisions

### A stamped price, and the order born at payment

The product owner chose this on 2026-10-27, calling it the Stripe path.

The unpaid request asks the merchant the price and answers 402 as today, with
the price in `amount`. The gateway writes nothing. In place of
`extra.order_id`, the payment requirements carry the price under the gateway's
own stamp: an HMAC-SHA256 computed with a secret only the gateway holds, over
the card, a digest of the purchase's parameters, a digest of the place a parcel
goes, the price, its currency, the moment until which it holds, and the price
question's identifier. No address travels in it, because the payment
facilitator sees the requirements and a discovery listing can publish them; the
paid request repeats the purchase's body, address included.

When the paid request arrives, the gateway recomputes the stamp from what came
back, checks that the term has not passed, and only then writes the order and
goes on as today: the payment is verified, charged and fulfilled. A forged or
edited price fails the stamp and is refused before anything is verified or
charged. The order's identifier is derived from the price question's
identifier, so the merchant's promise that a `price_id` is good once still
holds, and a buyer whose answer was lost and who signs the same challenge again
finds the same order instead of opening a second one. A card with a fixed price
takes its price from the card and asks nobody, as now.

The term is judged by the moment the paid request reaches the gateway, by the
gateway's own clock. The moment the agent signed is known only to the agent,
and the moment the charge goes to the chain is the gateway's own, which for a
card charged after its goods comes after the goods are made. The product owner
asked that the documentation say this. The signature's own validity, which the
agent sets, stays a separate rule as today: it must last until the charge.

The engineering consequences are these. With nothing written, the limit of
fifty goes away, and ADR-0048 keeps only the orders that still end with nothing
charged after a payment arrived. The dashboard's Lapsed segment, which exists
because unpaid orders filled the order list (commit `b8c22490`, 2026-10-21),
goes with it, and the product owner chose not to replace it with counters of
price questions. A price question lives five seconds, so it need not be a
durable job kept for days; it can be handed to the merchant's waiting poll from
memory, and a restart turns it into silence. The merchant's API stops listing
unpaid attempts, which no merchant outside our control reads yet.

### A gate in front of every merchant

The gate sits in the gateway, one per merchant, in front of the merchant's
queue. It is the same for the SDK and for WooCommerce, because the connector
draws its work from the merchant's stream as an SDK worker does; the product
owner asked for one gate for both. Its numbers are constants in the code, not
settings, and they start loose; the product owner wants to watch them before
tightening anything.

A price question enters the merchant's queue only if it can still be answered
within the five seconds the gateway waits, and is refused at once otherwise. A
long queue only postpones the same refusal
([Amazon Builders' Library](https://aws.amazon.com/builders-library/avoiding-insurmountable-queue-backlogs/)).
A question whose wait has run out is never handed to the merchant. Paid orders
are handed out ahead of price questions. A cap on requests per second is built
into the gate and set loose, so that it can be tightened the day a shop's bot
protection starts refusing Agentify's address, without a change in design.

What a question refused at the gate means depends on the card. For a card
charged after its goods, the machine already treats a merchant's silence as a
sale at the card's own price (`sellsOnSilentQuote` in
`packages/core/src/orders/machine.ts`), and the merchant can still refuse the
order before any money moves; a question that did not fit is the same silence.
For any other card the purchase is refused as `seller_busy`, HTTP 429 with a
`Retry-After` of a second or two, which now means that the merchant is busy
this moment. The gate has to be in place before the fifty is removed, or the
whole flood reaches the shop.

Later, and not decided: the SDK and the connector could keep one of their four
places for paid orders only. That needs an SDK release that merchants install.

### One merchant never slows another

Most of what a merchant uses is already separate: the queue is a stream per
merchant, the connector's places and its connections are per shop, and the
gate will be per merchant. Two resources stay shared by every merchant, the
gateway's one database pool and the one facilitator key, and both are open
questions in [00-open-questions](00-open-questions.md). The rule is held by a
test that a flood of requests for one merchant does not delay a purchase from
another; check J-09 of [42-manual-test-plan](42-manual-test-plan.md) already
describes it by hand.

### WooCommerce reads less and leaves nothing behind

The product owner agreed both changes. A price question today reads the product
and eleven shop settings (`SETTING_PATHS` in `woo-shop.ts`), and a parcel adds
the cart calls for its shipping rates, up to eighteen calls in all. The
settings are the same for every buyer and change rarely, so the connector keeps
them for a few minutes; the product changes more often, so it keeps it for a
few seconds; only the shipping rate for the given place is read per question.
A price changed in the shop reaches buyers a few seconds late, which sits
inside the thirty seconds a named price already holds.

Instead of a fresh guest cart per question, the connector keeps a few carts per
shop, one per place it may work in at once, and reuses them: the product in,
the place set, the rates read, the product out. The shop then holds at most
that many of Agentify's carts, each with only the last destination. Whether a
cart token can be reused like this, and how long it lives, is not known yet and
is checked on the lab shop first. No extra cap on calls per second is set for
now.

### No limit per wallet, for now

For a card charged after its goods, one wallet holding one price can sign
several purchases at once; each signature passes the facilitator's check
against the same balance, the merchant makes the goods for each, and only one
charge goes through. The buyer gets none of the unpaid goods, because the
gateway holds them as `delivered_unpaid` until a repeat purchase pays, so the
cost is the merchant's making them. The product owner chose on 2026-10-27 not
to limit this now: correct the sentence in `apps/docs/failures.md` that puts
the risk at one sale's price, since it multiplies with purchases made at once;
advise a merchant whose goods cost money to make to charge before the goods;
and keep the limit as an open question until such a merchant sells that way.

### Documentation

The passage in `cards.md` that lets a merchant set stock aside against a price
is removed; the price simply holds until the moment named. The term of a price
is described as judged when the paid request reaches Agentify. These pages
change with the code that makes them true, not before it.

## The alternatives, and why they lost

Keeping the limit of fifty leaves the problem as it is, and the product owner
rejected it on 2026-10-26 (ADR-0043).

Asking the merchant again at payment is what x402's own reference server does.
It keeps nothing between the 402 and the paid request, runs the route's price
function again on the retry, and matches the client's `accepted` requirements
against the fresh ones, `extra` included as a subset check; if the price moved,
the buyer gets a new 402
([`x402HTTPResourceServer.processHTTPRequest`](https://github.com/x402-foundation/x402/blob/1148309d5bdf4db476c488048d34dc6706a1c6da/typescript/packages/core/src/http/x402HTTPResourceServer.ts#L546-L650),
[`findMatchingRequirements`](https://github.com/x402-foundation/x402/blob/1148309d5bdf4db476c488048d34dc6706a1c6da/typescript/packages/core/src/server/x402ResourceServer.ts#L1591)).
The x402 sellers surveyed do the same or price statically: xtended402, the
author of [issue 999](https://github.com/x402-foundation/x402/issues/999),
recomputes the price from the body on every request
([helpers.go](https://github.com/mvpoyatt/xtended402/blob/HEAD/server/go/helpers.go)),
[x402-mcp](https://github.com/ethanniser/x402-mcp/blob/HEAD/packages/x402-mcp/src/server.ts)
rebuilds fixed prices per call, and
[thirdweb](https://github.com/thirdweb-dev/js/blob/main/packages/thirdweb/src/x402/common.ts)
stores nothing and handles variable prices with the `upto` scheme. It lost
because the merchant already promises the price until `expires_at`, so asking
again doubts that promise; because it asks every paying buyer's merchant twice;
and because a price that moved refuses the buyer after they signed. Worked
through with the product owner: a buyer told 112.40 who pays while the
merchant's engine now says 113.50 buys at 112.40 under the stamp, as today, and
would be refused and asked to sign again under this alternative.

Keeping the order stored before payment is what the gateway does today, what
Crossmint's demo seller does with `orderId` in `extra`
([worldstore-agent](https://github.com/crossmint/worldstore-agent/blob/HEAD/server/src/routes/orders.js#L119-L232)),
and what the
[Agentic Commerce Protocol](https://github.com/agentic-commerce-protocol/agentic-commerce-protocol)
does with its checkout session. It lost because what is stored for free is what
anybody can fill for free.

Letting the merchant check the price when the order arrives lost for three
reasons. The merchant would have to remember every answer, so every free
question would be stored at the merchant instead. For a card charged before its
goods the check comes after the money has moved, and under
[ADR-0046](../decisions/0046-ten-unserved-orders-stop-a-merchant.md) ten paid
orders refused that way stop the merchant's sales, which would cost an attacker
ten times a cent. And the promise that a buyer is charged exactly the price the
merchant named would become a duty every integrator must remember.

Taking every price from the card works only for cards with a fixed price. A
card with a price check exists because the real price depends on the purchase:
a parcel's shipping on its destination, a WooCommerce shop's tax and shipping,
a sale in another currency at the merchant's rate.

The stamp itself is not new. The Payment HTTP authentication scheme of Tempo
and Stripe, an individual draft, binds a challenge's identifier to its fields
with an HMAC under a server secret so that the server may keep nothing
([draft-httpauth-payment-01](https://datatracker.ietf.org/doc/html/draft-httpauth-payment-01)).
An L402 token commits to its invoice and is checked through its HMAC chain
([L402](https://github.com/lightninglabs/L402/blob/master/protocol-specification.md)),
although Aperture still keeps a secret per token
([mint.go](https://github.com/lightninglabs/aperture/blob/master/mint/mint.go#L37-L49)).
x402's offer-receipt extension signs the offer in every 402, but marks it
dynamic, so it plays no part in matching the payment
([offer-receipt](https://github.com/x402-foundation/x402/blob/1148309d5bdf4db476c488048d34dc6706a1c6da/typescript/packages/extensions/src/offer-receipt/server.ts#L145-L151)).
No x402 seller was found that checks a stamped price without storing it, which
does not show that none exists.
[Issue 3873](https://github.com/x402-foundation/x402/issues/3873), opened on
2026-10-22 with no maintainer reply yet, proposes binding the payment's nonce
to the request; if x402 standardizes something like it, the gateway should move
to it.

`extensions` rather than `extra`. The specification reserves `extra` for the
payment scheme's keys and gives `extensions` to data the server wants back,
which the client must return without deleting or overwriting anything
([x402 v2](https://github.com/x402-foundation/x402/blob/main/specs/x402-specification-v2.md)).
In practice sellers put their own data in `extra`: Crossmint its order,
[Nevermined](https://nevermined.ai/docs/development-guide/nevermined-x402) its
identifiers, and x402's own Lightning scheme its invoice
([exact on Lightning](https://github.com/x402-foundation/x402/blob/1148309d5bdf4db476c488048d34dc6706a1c6da/specs/schemes/exact/scheme_exact_lnbtc.md)).
Real agents already return the gateway's `extra.order_id`. The product owner
chose to follow that practice. Agents treat the value as opaque, so moving it
later changes nothing for them.

A limit per wallet at the unpaid request cannot work, because the wallet is not
known there and proving one costs nothing
([87-unpaid-price-questions](87-unpaid-price-questions.md)). A limit per wallet
at payment was set aside as described above. Card payments do not have this
problem because an authorization holds the money, and prepaid schemes such as
Skyfire's tokens or Nevermined's credits reserve it in advance; x402's `exact`
verification by its specification commits nothing, and x402's own Express
middleware verifies, runs the handler, settles afterwards and discards the
response if settlement fails, with nothing against several payments from one
payer
([middleware](https://github.com/x402-foundation/x402/blob/main/typescript/packages/http/express/src/index.ts)).
A study of May 2026 found that race in official SDKs and in one production
deployment and proposes reserving before committing
([Free-Riding the Agentic Web](https://arxiv.org/abs/2605.30998)).

Fair sharing of the gate between sources, a separate room for agents signed
under directories other parties vet, a lane for agents that sign a payment
before the price, and a rate limit at the edge in front of the gateway through
Cloudflare are kept for later, when abuse or a merchant whose gate is often full
is seen. The product owner wants Cloudflare later as the outer layer. If it is
added, only per-address rate limits fit: challenges and bot-fight modes would
refuse honest agents, which are programs.

## What is not known yet

Whether a WooCommerce cart token can be reused for many questions and how long
it lives. How many price questions a second the lab shop answers before its own
limiter or host refuses, which sets the gate's number for WooCommerce. What
rate limit the facilitator applies to one key. Whether a card republished
between the 402 and the payment should sell on the terms the agent read or be
refused; today the order keeps the terms of the moment it was written, and the
build has to choose and hold the choice with a test. Whether anything else is
recorded when an unpaid order is written today, such as a metric or a log line
that someone reads, and where it goes once nothing is written.

## The order of work

The gate comes first, because it protects a shop on its own and the limit of
fifty cannot be removed before it. The stamped price and the order born at
payment come second, with the edit of ADR-0043 and ADR-0048 in the same
change, the removal of the Lapsed segment, and the documentation of the term.
The WooCommerce cache and the reused carts come third, after the cart check on
the lab shop. The correction in `failures.md` is true today and can land at any
point.
