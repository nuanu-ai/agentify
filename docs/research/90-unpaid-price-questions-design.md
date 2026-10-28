# Unpaid price questions: design and implementation

The product owner agreed this design on 2026-10-27 for the unpaid-purchase
problem in [research 87](87-unpaid-price-questions.md). The implementation is
in [PR #215](https://github.com/nuanu-ai/agentify/pull/215). This note separates
his decisions from engineering choices and records what remains unverified.
[ADR-0043](../decisions/0043-the-purchase-door-refuses-before-any-charge.md),
[ADR-0048](../decisions/0048-an-attempt-that-lapsed-unpaid-is-deleted-after-thirty-days.md)
and [ADR-0049](../decisions/0049-a-price-travels-with-the-buyer.md) hold the
resulting rules. Review and TEST acceptance remain separate from implementation.

## The problem addressed

An unpaid request originally wrote an order before asking the merchant its
price. Fifty outstanding prices stopped further purchases for that merchant.
One caller could keep those places occupied without paying. The rows remained
for thirty days, and durable price questions shared the merchant’s queue with
accepted orders. The WooCommerce connector also opened a new guest cart for
each shipping calculation. A price that reserved stock exposed another form
of unpaid inventory holding
([OWASP OAT-021](https://owasp.org/www-project-automated-threats-to-web-applications/)).

## The owner's decisions

“A request nobody paid for may use a moment of a merchant's capacity and holds
nothing over time” and “Work that is paid for never waits behind work that is
not.” The owner also requires one merchant's load not to slow another.

He chose a stamped price that travels with the buyer, with the order written
when payment arrives. The gateway keeps the merchant's price until its stated
term; it does not ask the merchant to price it again. A repeated saved challenge
finds the same order. The price term is judged when the complete paid request
reaches Agentify, not when the buyer signs or the chain executes the payment.

One admission gate protects both SDK and WooCommerce merchants. Its initial
bounds are loose code constants, with no new settings. The limit of fifty and
the merchant's Lapsed view are removed, without replacement price counters.
A request with no admitted price question uses the existing silent-price path
for synchronous goods; other modes refuse with `seller_busy` and a short
`Retry-After` before any order or charge.

The owner approved short product caches, longer settings caches and a small
reusable cart pool for WooCommerce, subject to a lab check. No additional shop
request-rate cap is introduced. He also approved a generic optional
`quote_reference` to carry a merchant's calculation confirmation. The stamp
covers it, the buyer can read it in the 402, and documentation forbids secrets
or personal data in it. The Woo quote table and its code are removed together.
A connector's needs alone do not justify expanding the public contract.

There are no external consumers requiring compatibility: old `extra.order_id`
payment challenges are removed rather than supported beside stamped prices.

A wallet quota, a reserved SDK execution slot, fair lanes for callers, vetted
agent directories and Cloudflare protection are deferred. For a synchronous
sale, concurrent signatures can all pass verification against one wallet's
balance before any charge executes. The merchant's production cost can multiply
across those purchases. Documentation explains that risk and recommends payment
before fulfillment when producing the goods costs money.

## Engineering choices in the implementation

The per-merchant gate admits four active price questions and sixteen admissions
per second. These numbers are initial bounds, not measured shop capacity. An
admission occupies a place only while the HTTP caller waits, at most five
seconds. Ready accepted orders and events are selected before price questions;
a running SDK handler is not preempted. One merchant cannot fill another's gate.
The gateway's shared database pool and facilitator key remain common resources;
this change establishes no global load or denial-of-service isolation.

A price question lives only in gateway memory, including when pg-boss handles
durable work. It is removed when the caller stops waiting. A restart drops
questions instead of replaying requests whose callers are gone. This topology
assumes one gateway process per deployed channel; multiple gateways would need
a separate design for routing merchant polls and their transient questions.

The opaque `extra.price_stamp` is an HMAC-SHA256 authenticated payload. It binds
the price identifier, merchant and integration, published card and merchant
policy, canonical parameters, parcel locality, amount and currency, price source,
timestamps, original chain/token/signature domain, payee and authorization
window. Parameters and locality use keyed digests. The stamp contains neither
a buyer key nor the full delivery address. The paid retry repeats the JSON
body. A fixed-price card takes its price from the card without merchant work.

The gateway authenticates the stamp, checks arrival within its term, then
writes an order before verifying the signature, as the handoff specifies.
The price identifier determines a stable order identifier. Concurrent births
preserve the first buyer key and emit creation effects once. Invalid payment
verification establishes no owner, payment claim or full address. A rejected
signature can leave a hidden unowned admission row: this work removes free
price rows, not every possible write from an invalid paid request. Safe
thirty-day cleanup covers those records after the price expires and preserves
all accepted or unknown financial outcomes.

An unconsumed offer is refused if the card, merchant policy, integration or
payee changes. A verified owner freezes the complete address within the priced
locality under the same merchant/order locking boundary. Accepted orders retain
their exact financial requirements. Verification that finishes after the price
term still completes a request admitted in time. Paid recovery uses the exact
saved stamp and a fresh owner signature; the original spent authorization is
rejected. No new buyer package is introduced.

`PRICE_STAMP_KEY` is a separate random channel secret of at least 32 bytes,
stable across releases. Rotation installs a new current key and retains the old
one in `PRICE_STAMP_PREVIOUS_KEY` until outstanding price terms expire. Paid
recovery uses the exact saved offer after signing keys are retired. Keys never
appear in health, logs, merchant settings or payment requirements. The public
contract is version 6.

WooCommerce keeps successful product reads for five seconds and successful shop
settings reads for three minutes, coalescing simultaneous reads. Paid inspection
uses fresh product and settings data. Failed refreshes do not serve stale data;
credentials and connection changes invalidate the caches. A compact generic
calculation reference replaces the durable quote ledger, with no shop-specific
field in Core.

Each shop runtime owns four exclusive reusable carts. Each quote replaces the
whole locality, adds its product, reads shipping and removes the product. Reuse
requires confirmed empty state. A started mutation gets its own bounded request
budget even if the price caller times out; shutdown waits for cleanup. An
uncertain mutation quarantines its cart. HTTP 202/206, proxy errors and lost
responses cannot establish that a mutation completed. A known empty cart can
renew after the issuing shop's declared token expiry; an uncertain cart cannot.

Four slots bound this runtime's active carts. They do not prove a lifetime bound
on the shop's stored sessions: restarts and token renewal may leave older shop
sessions until WooCommerce purges them. Four uncertain or tokenless outcomes
can exhaust the local pool; it then refuses safely rather than opening more
carts. Automatic recovery of that exhausted condition is not established.

## Lab evidence and its limits

The pre-registered lab probe used the actual Nuanu Tote Bag, product 23, on
`woo.nuanu.ai`. Twenty-two serial Store API requests took 31.366 seconds and
spent nothing. The original token worked across Bali, Jakarta, a German
location without rates and Bali again; each successful removal left the cart
empty. Full locality replacement mattered: clearing the previous state was
needed for the German request. The returned JWT values changed, while their
user identity remained the same. Their declared `exp - iat` was 172800 seconds.

The probe did not inspect WooCommerce session rows, wait for real token expiry,
measure sustainable capacity or flood the shop. A declared two-day lifetime is
not proof of actual expiration or cleanup. Evidence is summarized in the
[handover checks](2026-10-27-unpaid-price-validation.md); the raw local probe
contains token hashes rather than token values.

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
merchant's engine now says 113.50 buys at 112.40 under the stamp, under the accepted design, and
would be refused and asked to sign again under this alternative.

Keeping the order stored before payment was the gateway’s original design, what
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
The clients examined in the design discussion returned the gateway's former `extra.order_id`. The product owner
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

## Remaining measurements and operational questions

Shop capacity, response-time distributions, real cart expiry and server-side
session cleanup remain unmeasured. Shared database and facilitator isolation,
facilitator quotas and fairness between callers are tracked in
[open questions](00-open-questions.md). The gate constants must not be described
as a capacity benchmark. The local tests establish bounded admission and
selection order; they do not establish product acceptance or completed TEST
payments.
