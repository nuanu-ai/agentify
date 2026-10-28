# Unpaid price questions: the design as built

This note describes how Agentify answers purchases nobody has paid for yet, as
the design stands in the code: a price that travels with the buyer under the
gateway's stamp, an order written only when a verified payment arrives, and
gates per merchant for price questions and for payment checks. It separates
the product owner's decisions from engineering choices, gives the evidence for
each and lists what is still exposed. The problem it answers is surveyed in
[research 87](87-unpaid-price-questions.md), and the rules that are expensive
to reverse are in
[ADR-0043](../decisions/0043-the-purchase-door-refuses-before-any-charge.md),
[ADR-0049](../decisions/0049-a-price-travels-with-the-buyer.md) and
[ADR-0023](../decisions/0023-woocommerce-connect.md). The implementation is in
pull request #217.

## The problem

An unpaid request used to write an order before asking the merchant its price.
Fifty outstanding prices stopped further purchases for that merchant, so one
caller could keep those places occupied without paying. The rows stayed for
thirty days, and durable price questions shared the merchant's queue with
accepted orders. The WooCommerce connector also opened a new guest cart in the
shop for every shipping calculation. A price that reserved stock would have
been another way to hold inventory without paying
([OWASP OAT-021](https://owasp.org/www-project-automated-threats-to-web-applications/)).

## The product owner's decisions

On 2026-10-26 the product owner rejected the limit of fifty, because nobody
should be able to stop a merchant's sales without paying. On 2026-10-27 he
gave the rule the design follows: "A request nobody paid for may use a moment
of a merchant's capacity and holds nothing over time" and "Work that is paid
for never waits behind work that is not." One merchant's load must not slow
another's either.

He chose a stamped price that travels with the buyer, with the order written
when payment arrives. The gateway keeps the merchant's price until its stated
term and does not ask the merchant to price it again. A repeated saved
challenge finds the same order. The term is judged when the complete paid
request reaches Agentify, not when the buyer signs or the chain executes the
payment. On 2026-10-28 he set the term at three minutes, because an agent may
show the price to a person: "нужно хотя бы три минуты" (at least three minutes
are needed). The same day he accepted ten seconds for a merchant to answer a
price question: "да, 10 секунд нормально" (yes, ten seconds is fine).

One admission gate protects both SDK and WooCommerce merchants. Its bounds are
loose code constants, with no new settings. The limit of fifty and the
merchant's Lapsed list are removed, and no counter of outstanding prices
replaces them. A request that gets no place for its price question sells a
synchronous card at its card price, as a silence does; other modes refuse with
`seller_busy` and a short `Retry-After`, before any order or charge.

He approved short product caches, longer settings caches and a small pool of
reused carts for WooCommerce, subject to a lab check, with no cap on the rate
of requests to a shop. On 2026-10-28 he decided that a cart whose state is in
doubt is never used again and that a new one is opened automatically at most
once per shop every ten minutes. He also approved a generic optional
`quote_reference` that carries a merchant's confirmation of its calculation.
The stamp covers it, the buyer can read it in the 402, and the documentation
forbids secrets and personal data in it. The connector's table of quotes and
its code are removed. A connector's needs alone do not justify widening the
public contract.

There are no outside consumers to stay compatible with, so challenges carrying
the old `extra.order_id` are removed rather than supported beside stamped
prices. He chose to carry the stamp in `extra`, following what x402 sellers do,
over `extensions`, which the specification describes (see the alternatives
below).

A wallet quota, a reserved place in the SDK's handlers, fair lanes between
callers, vetted agent directories and Cloudflare protection are deferred. For
a synchronous sale, several signatures from one wallet can all pass
verification against the same balance before any charge executes, and the
merchant's cost of making the goods can multiply across those purchases. The
documentation explains that risk and recommends payment before fulfillment
when making the goods costs money; whether to limit it is an open question in
[00-open-questions](00-open-questions.md).

## The price and its stamp

`extra.price_stamp` is an opaque value authenticated with HMAC-SHA256. It binds
the price's identifier, the merchant and the integration, a digest of the
card's published terms and of the policy they give, keyed digests of the
canonical parameters and of a parcel's locality, the amount and currency, where
the price came from (the card or the merchant's answer), its times, the chain,
token and signature domain, the payee and the authorization window. It holds no
buyer key and no full address, so the paid retry repeats the JSON body. The
card's digest leaves out when the card was published, so a card republished
unchanged keeps the prices already given for it. A changed seller site voids no
price either; that is an engineering choice, made when the product owner asked
about it. A fixed-price card takes its price from the card with no merchant
work, so its stamps cost nothing to obtain.

`quote_reference` is 1 to 512 printable ASCII characters. At its widest, with a
reference of 512 characters that JSON escapes, the stamp is 2,173 characters,
which take about 2,900 bytes of the 8,192-byte challenge header once it is
encoded; a stamp with no reference takes about 1,100. A card is measured with
the widest stamp before it is published, so a priced purchase never answers
wider than its card was measured.

`PRICE_STAMP_KEY` is a separate random channel secret of at least 32 bytes,
stable across releases. Rotation installs a new current key and keeps the old
one in `PRICE_STAMP_PREVIOUS_KEY` until the outstanding terms have run out. A
stamp that does not authenticate under either key is taken only when it is,
byte for byte, the saved price of an existing order, at the cost of one read,
so a buyer can still get a paid purchase back after both keys have moved on.
Keys never appear in health, logs, merchant settings or payment requirements.
The public contract is version 6.

## Price questions

A price question lives only in the gateway's memory while its caller waits,
including when pg-boss holds the durable work. It is removed when the caller
stops waiting, and a restart drops it rather than replaying a request whose
caller is gone. Ready accepted orders and events are drawn before price
questions, and a running SDK handler is not interrupted.

The gate per merchant admits four questions at once and sixteen started in any
one second, the second counted from each admission so that a burst at the end
of one second cannot double up with the start of the next. Sixteen more may
wait in line. A question waits for a place for two seconds at most, and never
for more than half of its answer window. Then a synchronous card sells at its
card price without asking the merchant, and a card paid before delivery
answers `seller_busy`, HTTP 429, with `Retry-After: 2`. Four is the number of
messages an SDK worker handles at once; sixteen a second is a loose bound on
how fast questions reach one merchant, whatever the pace of its answers. These
are not measured shop capacity.

A price question that was asked and not answered in time, on a card paid
before delivery, answers `seller_busy` with `Retry-After: 10`, retryable. Its
words say that nothing was charged, that the purchase may go through if asked
again, and that a silence which repeats means the seller's price check is not
answering. It asks for a longer wait than a full gate does because, unlike a
full gate, a silent price check may be down for good: a handler that always
times out, or a shop whose keys are gone. A merchant's answer that the product is unavailable answers
`not_selling`, which is not retryable.

A merchant with nothing under way and nobody waiting is forgotten, so the gate
holds only merchants with live work, whatever identifiers callers present. One
merchant's questions never take another's places.

A merchant whose own code has not polled for ten minutes is refused before any
of this (ADR-0043). Contact is a poll speaking the gateway's contract
(ADR-0006), recorded per merchant at most every thirty seconds per process and
kept in the database, so a restart refuses nobody. A process whose handlers
are all busy does not poll and counts as quiet. Cards the merchant paused stay
paused when contact returns, and the catalogue and the purchase door read one
rule for whether a card can be priced now.

## Time limits

A price holds for three minutes (`QUOTE_TTL_MS`), counted to when the complete
paid request arrives. A merchant has ten seconds to answer a price question
(`QUOTE_RESPONSE_MS`); the WooCommerce connector gives itself one second less,
so its answer is in before the gateway stops waiting.

The 402 asks the buyer's authorization to stay valid for 215 seconds
(`maxTimeoutSeconds`) at the default deadlines. That is the price's three
minutes, then the longest a payment presented as its price runs out may wait
before its check answers (a second for a place among the merchant's reads of
payers' wallets, two for the read, two for a place among its checks and ten for
the check), then the eighteen seconds a card charged after its goods needs
past the check (the merchant's ten, the facilitator's six-second margin and two
for the gateway's own steps), and two more for the check's round trip and the
client's rounding. It is not a time to pay in, since the price lapses first.
Such a card's payment that checks out with less time left than its charge
needs is refused before anything is made: its words ask the agent to sign
again at once while the price holds, or to request a new price once it has
lapsed. The arithmetic is in `apps/gateway/src/app/payment-window.ts`, and the
measurements behind it in [research 46](46-charge-answer-timing.md).

The check of a payment gives up after ten seconds and a charge request after
thirty. A card charged before its goods waits thirty-five seconds for its
charge's answer, the thirty a request may take and five to record the answer,
and the gateway refuses to start with a shorter wait. A card's
`fulfill_deadline_seconds` runs from a minute to thirty days and is refused at
publication outside that range. An order nobody answers is handed over again
for three hours from its first hand-over
([ADR-0004](../decisions/0004-worker-transport-long-poll.md)).

## Payments

### Before the payment is checked

The stamp is authenticated before any gate is entered or the order is read, so
a forged stamp costs at most one read. The term is judged against the moment
the complete paid request arrived. Then the card and the merchant are checked
as they stand: a card off sale, a switched integration or a missing seller site
on a card paid before delivery answers `not_selling`, saying that nothing was
charged, and a missing site in its own words; a changed card or payee answers
`payment_not_taken`, not retryable. The same cause gets the same answer here
and again inside the admission.

Inside one gateway process, one request per price is checked at a time. A
second request for the same price, while the first is being checked, is
answered HTTP 409 `payment_not_taken`, retryable, with `Retry-After: 2`. The
words neither say that nothing was charged nor suggest buying again, because
the first request may still be charged; they ask the agent to send the same
request again to learn how the purchase stands.

### The two lanes

Payments are checked per merchant in two lanes. A payment whose EIP-3009
signature is 65 bytes and recovers, here and without asking anybody, to the
`from` address it names goes into the buyer lane: four checks at once and
sixteen waiting. Any other signature goes into the unproven lane, two checks at
once and four waiting: a contract wallet's, an ERC-6492 wrapper, or bytes that
are no signature at all. Those payments wait behind each other and never in
front of a buyer whose own key signed. A payment that finds its line full, or
no place within two seconds, is answered `seller_busy`, HTTP 429, with
`Retry-After: 2`, and the agent sends the same request with the same payment
again. The gate says which bound turned a payment away: where the payment's own
wallet already holds a place or a place in line at this merchant and that kept
it out, the words are the wallet's (it already has a payment being checked at
this seller; send this one again once that one has its answer); where other
payers' payments took the places and the line, the words stay the seller's.
The code and `Retry-After` are the same in both. There is no cap across
merchants in the process. The lanes decide only
where a payment waits; the facilitator still decides whether it is valid.

In each lane one payer holds at most one place and one place in line per
merchant, so holding more places takes more wallets. A second payment from a
payer already waiting is turned away at once, and one from a payer holding a
place waits until that place is given back. In the buyer lane the payer is the
wallet whose key signed. In the unproven lane it is the `from` the payment
names, which nobody has proved, and every payment that names no wallet counts
as one payer. This bound per payer is an engineering choice. It makes noise in
the unproven lane spend a fresh claimed address per place, which costs nothing,
so there it bounds nothing beyond the lane's own size.

### What is refused before any lane

Some payments the token itself would refuse at the charge, so the gateway
refuses them before they take a place, from what the payment and the chain
already say. An authorization whose `validAfter` lies more than thirty seconds
past the gateway's clock is not valid yet. A signature by a wallet's own key in
the high-s form, with `s` in the upper half of the curve's order, is refused,
since the token accepts only the lower form. For a payment that charges, the
gateway then reads, in one batched request to the chain endpoint, the chain's
identifier, the wallet's token balance and the token's `authorizationState` for
the authorization's nonce. A nonce the token already marks used or cancelled is
refused, and so is a wallet holding less than the price, with
`payment_not_verified` and the balance named. Each refusal says that nothing
was charged.

A balance read that could not be made sends the payment to the unproven lane
and refuses nothing: an endpoint that failed or timed out after two seconds, no
chain endpoint configured, or no place among the merchant's reads of payers'
wallets. Those reads are bounded per merchant at two at once and eight waiting,
and a payment waits a second at most for one, because the endpoint is shared
with payment recovery and a flood at one merchant must not keep it busy. Reads
about the same authorization at the same time are one read. A read is kept for
five seconds for the one authorization it was made for, its wallet and nonce,
and only for a price it covers, for at most 1,024 authorizations, the oldest
dropped first, so one buyer's retries of one payment ask the chain once and a
buyer who tops up a wallet that held too little can pay at once. Another
authorization from the same wallet is always read, because the token may have
marked it used or cancelled since. A read that found an authorization used is
never kept, and it replaces any earlier read of that authorization.

Getting a paid purchase back charges nothing, so it is never judged by the
wallet's balance: it uses the same lanes and skips the read. For the same
reason a refusal of such a payment at the facilitator is never relabelled as an
empty wallet (see "An empty wallet the facilitator does not name" below).

The facilitator's check gives up after ten seconds and the charge after thirty,
both set explicitly on the client, since a check holds one of the merchant's
places while it waits. The database pool waits at most three seconds for a
connection.

### Admission

Verification holds no database transaction, lock or connection. Only a
verified payment is admitted, in one short transaction: it tries a transaction
lock on the price, finds no order, holds the merchant's row `for no key update`
and the card `for share`, checks the standing again (card terms, payee, the
selling switch, the integration and, for a card paid before delivery, the
seller's site), records the authorization's fingerprint, made from its payer
and nonce, against this order alone, and writes the order, its jobs and its
order-created analytics together. A price whose lock another request holds is
answered as a second request for it is, HTTP 409 `payment_not_taken`,
retryable. The transaction sets a lock timeout of two seconds, and a row lock
not granted in time (PostgreSQL's 55P03) ends the admission held up with
nothing written: HTTP 503 `gateway_failed`, retryable, with `Retry-After: 2`,
saying that the payment was not used and nothing was charged. That also turns
away a payment while a legitimate edit holds the merchant's row or the card
for longer. The charge runs after commit. A connection lost before commit leaves nothing written and
charges nothing.

Parameters or a locality other than the stamped ones are refused only after the
payment verifies (`payment_not_taken` or `ship_to_changed`), so a published
stamp cannot be used to test guesses about another buyer's parameters or
address. The first verified payment writes the full address with the order.

A failure on Agentify's side before the first write is answered by what it is.
A write that never began wrote nothing and is answered HTTP 503
`gateway_failed`, retryable. Before the first write, only a failure that can
pass by itself is retryable: no connection, a lost connection, a lock not
granted, the database shutting down or out of connections, and a serialization
failure or deadlock. Anything else is HTTP 500 `gateway_failed`, not retryable,
saying that nothing was charged. A failure at or after admission is reported as
an outcome nobody knows.

The in-memory guard is one process's. With a second gateway process on a
channel, the admission would still make one order of one price (a test holds
two processes to that), but both processes would verify the same payment at
once. A second process is the exit trigger in ADR-0049.

### A payment signed for the listing, and the listed example

A payment signed against a listing challenge carries no stamp. It gets a fresh
priced 402, with nothing verified or charged, through the ordinary validation
of a purchase, and the reason "the payment was for the listing and charged
nothing; here is its price", 70 characters. Every challenge reason is measured
into a card's widest header, so a new reason must not be longer than the
longest there is, 73 characters, or cards published at the limit answer wider
than they were measured.

After a payment settles through Coinbase's CDP facilitator with
`extensions.bazaar` in its challenge, Coinbase's indexer replays the card's
declared example input as an unpaid purchase
([get discovered](https://docs.cdp.coinbase.com/x402/seller/get-discovered)).
It was seen on TEST since 2026-10-20 after about half of the payments, and on
production after three of four payments since 26 October. The follower arrives
0.5 to 3 seconds after settlement, from a different TLS client. For a card that
declares parameters, the example holds a word naming each parameter's type,
and for a parcel the schema's sample address, which is a real office address,
so the replay asked the merchant to price values no buyer meant. A body equal
to the card's own example, where the card declares parameters or is a parcel,
is now answered as the listing probe is and the merchant is not asked. A
listing-signed payment carrying it gets the listing with the listing-signed
reason. A card with neither parameters nor an address lists the body a real
purchase sends, so its example remains a purchase like any other.

### An empty wallet the facilitator does not name

On TEST on 2026-10-27, an honest payment from a fresh wallet holding no test
USDC was refused at verification with `invalid_payload` and "execution
reverted", which names no cause, and Agentify could only say it did not know
whether funding, a new signature or a new purchase would help. The facilitator
named an explicit insufficient-funds code nowhere in that run.

As an engineering choice, a verification refusal whose code names no cause
(`unexplained`, `unrecognised` or none) is now held against one batched read
from the chain, `eth_chainId` and `balanceOf` in one request with a two-second
limit and no retries. If the wallet holds less than the amount, the refusal is
relabelled `insufficient_funds`, naming the balance and keeping the
facilitator's words. A code that names a cause is never relabelled, nor is a
refusal at settlement or of a payment that only gets a paid purchase back, and
a balance from another chain is never taken. The
balance pre-check in the buyer lane usually refuses such a wallet before the
facilitator is asked. Whether CDP refuses an empty wallet at verification or
only at settlement is open: the TEST observation was on Base Sepolia, and the
live chain is untested.

### Orders opened before this release

An order opened before prices were stamped keeps no saved payment requirements.
Such an order refuses to settle and says so: it "was opened before prices were
stamped and keeps no saved payment requirements, so an operator has to finish
or close it by hand". Before the release, a channel's open ones are listed with

```sql
select id, merchant_id, state from orders where price_offer is null and open;
```

Production held none on 2026-10-28. The release cannot be rolled back past the
dashboard's migrations `0025_stateless_woo_quotes` and
`0026_woo_cart_resources`, because the first drops the connector's quote
ledger, which every earlier revision writes at each price question
(`deploy/README.md`).

## WooCommerce carts

### Reads and their caches

The connector keeps a successful product read for five seconds and a
successful read of the shop's settings for three minutes, and simultaneous
reads share one request. The read at payment is fresh. A failed refresh serves
nothing stale, and a change of credentials or connection empties the caches.
The cache drops expired entries when it adds one, keeps no entry over 256 KiB
and holds at most 139 entries per connection. The `quote_reference` carries the
product and settings facts the price rests on, with no shop-specific field in
the core and no stored quote.

### Lanes and the replacement allowance

A shop has a paid lane and a free lane of guest carts, eight slots each. Four
handlers may each calculate the destination and, for a shop that enters prices
with tax, the tax base at once, which is two carts per handler. There is no new
SDK option and no increase in handlers. A free question may not spend the
replacement allowance while fewer than two paid slots are in use or can open
without it.

Polling never waits for carts. Downloads, their prices and order events use
none. A parcel order takes one paid cart per question after it is drawn. It
waits only for a paid cart another calculation is using; otherwise it answers
nothing and waits for its next hand-over, and hand-overs go on for three hours
after the first (ADR-0004).

These openings are free of the allowance: a slot's first opening, counted only
once the shop issues a session; the renewal of an idle empty cart within five
minutes of its token's expiry; a slot whose token no longer decrypts after a
key rotation; and a replacement whose opening issued no session, which gives
the allowance back. Everything else is budgeted at one new session per shop
every ten minutes: retirement after a doubtful change, a refused session, and
an interrupted claim on a cart in use. A session with under an hour left is not
kept for reuse.

### What retires a cart

A cart is retired when a change's outcome is unknown: a transport error, a 5xx,
a 408, a 2xx that does not acknowledge the change, or an unstructured 4xx other
than 401, 403 and 429. It is retired when WordPress refuses the session in its
own shape, and when its identity or ownership is lost. Nothing is retired for
a 429 with any body, for a 401 or 403 from something in front of the shop, or
for a read without a token that failed.

After a reused session is refused, the question tries another cart; a fresh
session refused ends the question. After a failed opening, only carts that
already hold a session are tried. A paid order is never refused because a
session was refused, a firewall answered with its own page, or a page arrived
in place of a change's acknowledgement.

### The registry

The registry is keyed by the shop's normalized origin, across accounts,
reconnects, credential revisions and worker restarts, so two accounts
connected to one shop share its carts and its allowance, while their
credentials and read caches stay apart. Connecting the same shop from a second
account stays allowed, because testers share the TEST lab shop. The registry
keeps each slot's right to a first opening, the allowance's next time and the
ownership, and it writes only when something changed. Idle tokens are encrypted
under a key derived for this purpose from the dashboard's authentication
secret. A cart in use when the worker restarted is retired, and a stale owner's
completion cannot restore or change the new owner's state; ownership is
checked before encrypted state is decoded or changed. A new, restored or
refreshed token's identity is registered atomically before the cart is used,
so rotating token bytes cannot give two slots one shop session. A registry
that failed to start is retried, and a runtime whose carts were taken over is
replaced after ten minutes.

### How many sessions a shop holds

With WooCommerce's default guest session of 48 hours, a shop holds about 300
unexpired sessions from Agentify at most: the sixteen slots and about 288
replacements over two days. It usually holds sixteen or fewer. Each rotation of
Agentify's key adds up to sixteen more, a renewal briefly overlaps old and new,
and a registry failure during registration can leave one extra. A shop whose
sessions last less than about an hour falls back to one cart every ten minutes
after its first sixteen. Expired rows may remain until the shop purges them;
when it does has not been measured. Full recovery can take several ten-minute
intervals, with no staffed step and no new merchant setting.

### Import and orders from before this release

Import asks the shop for a guest cart once when it has a parcel. A refusal holds
each parcel back on the "to fix" list, naming the HTTP status and what the shop
has to allow. An order paid before this release carries no quoted price and is
refused before the shop is asked, in words that claim no change.

## Evidence and its limits

A pre-registered probe on 2026-10-27 used the Nuanu Tote Bag, product 23, on
`woo.nuanu.ai`. Twenty-two serial Store API requests took 31.366 seconds and
spent nothing. The original token worked for Bali, Jakarta, a German location
without rates and Bali again, and each successful removal left the cart empty.
Clearing the previous locality fully was needed for the German request. The
returned JWT values changed while their user identity stayed the same, and they
declared a lifetime (`exp - iat`) of 172,800 seconds.

A second probe on 2026-10-28 made twenty anonymous requests in 7.249 seconds,
with no orders or payments. The cart part of a free calculation with its
cleanup took 2.827 seconds, and 2.061 seconds after a restart; the paid lane in
parallel took 2.388 and 2.029 seconds. After the registry was restored from
PostgreSQL no new carts opened, paid and free sessions stayed apart, and every
cart used was confirmed empty. The prediction that the cart part would exceed
four seconds at least once was not borne out. The probe left out private reads
of products and settings, the tax-base check, currency rates and the worker's
transport, so it does not establish how long a full price answer takes or how
many a shop can serve.

On TEST on 2026-10-28, the documentation's buyer program bought a real file
from an internal test merchant at 0.01 test USDC. A proxy cut the first paid
answer after the gateway reported payment; running the program again returned
the same order and goods with a fresh signature and no second charge, and an
intended second purchase made a second order. Two transfers of 0.01 went to the
merchant's split on Base Sepolia, 0.02 test USDC in all against a cap of 0.05.
The database held no new order before each first payment, the 402 carried
`price_stamp` and no `order_id`, and the purchase replies carried `no-store`.
This run accepts that scenario only: arbitrary wallets and MCP clients, Bazaar
visibility, shop throughput and production remain unverified.

Neither probe inspected WooCommerce's session rows, waited for a real token to
expire, measured sustainable capacity or flooded the shop. A declared two-day
lifetime is not proof of expiry or cleanup.

## What remains exposed

Stamps for fixed-price cards cost nothing to obtain, and unpaid floods and the
reads of the card and the merchant before any gate are not bounded by a gate.
Payers with contract wallets share a small lane with noise, and under a flood
they get `seller_busy`; since that lane's payer is only the address a payment
claims, one place per payer does not slow a flood there. If the chain endpoint
cannot be read, from a rate limit or an outage, every payment goes to that
small lane, honest buyers' included, and each fresh wallet costs one read from
the chain. The facilitator, the chain endpoint and the database are shared by
every merchant. A lock held for more than two seconds answers HTTP 503 even
when a legitimate edit holds it. Two accounts connected to one shop share its
carts. Several purchases from one wallet can pass verification against one
balance on a synchronous card.

A stream of payments from freshly made empty wallets, about 25 a second at one
merchant, fills that merchant's two wallet reads and then its small line, so a
first-time buyer whose balance cannot be read in time is told the seller is
busy while the stream lasts; a buyer whose read is kept from the last five
seconds still passes. Nothing is charged, and other merchants are unaffected.
Only the sender's address tells such a stream apart, which the gateway does not
judge. The product owner agreed on 2026-10-28 to release with this exposure and
to make a limit per sender address at the edge, such as Cloudflare, the next
step ("согласен").

Both channels read the free public Base endpoints by default
(`https://mainnet.base.org` on production), which limit requests per address.
That one endpoint now carries the reads of payers' wallets before their checks,
automatic payment recovery, the reads that check a payment presented to get a
paid purchase back (a contract wallet's signature among them), the balance read behind a verification refusal that names no
cause, and the payout figure on the merchant's Settings. A busy hour at one of
them can use up what the others need, and the first to suffer is the buyer
lane. Production should get a keyed endpoint from an RPC provider in
`AGENTIFY_PAYMENT_RPC_URL` (`deploy/README.md`); this is a recommendation for
the operator and has not been done.

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
merchant's engine now says 113.50 buys at 112.40 under the stamp, and would be
refused and asked to sign again under this alternative.

Keeping the order stored before payment was the gateway's original design, what
Crossmint's demo seller does with `orderId` in `extra`
([worldstore-agent](https://github.com/crossmint/worldstore-agent/blob/HEAD/server/src/routes/orders.js#L119-L232)),
and what the
[Agentic Commerce Protocol](https://github.com/agentic-commerce-protocol/agentic-commerce-protocol)
does with its checkout session. It lost because what is stored for free is what
anybody can fill for free. Its thirty-day deletion of unpaid attempts, the
Lapsed list and the ways of creating such attempts for tests went with it; paid
history, including outcomes nobody knows, stays.

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

A key for the order that the buyer's client keeps would add a duty to every
buyer and does nothing to bound unpaid work; the buyer example keeps the 402
for recovery instead
([ADR-0011](../decisions/0011-agent-collection-door.md)).

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
The clients examined in the design discussion returned the gateway's former
`extra.order_id`. The product owner chose to follow that practice. Agents
treat the value as opaque, so moving it later changes nothing for them.

A limit per wallet at the unpaid request cannot work, because the wallet is not
known there and proving one costs nothing
([87-unpaid-price-questions](87-unpaid-price-questions.md)). A limit per wallet
at payment is deferred, as above. Card payments do not have this problem
because an authorization holds the money, and prepaid schemes such as Skyfire's
tokens or Nevermined's credits reserve it in advance; x402's `exact`
verification by its specification commits nothing, and x402's own Express
middleware verifies, runs the handler, settles afterwards and discards the
response if settlement fails, with nothing against several payments from one
payer
([middleware](https://github.com/x402-foundation/x402/blob/main/typescript/packages/http/express/src/index.ts)).
A study of May 2026 found that race in official SDKs and in one production
deployment and proposes reserving before committing
([Free-Riding the Agentic Web](https://arxiv.org/abs/2605.30998)).

The first bound on payment checks was one verification at a time per merchant
and four per process, with the admission's lock and a pooled connection held
across the facilitator call. A forged stamp entered the gate under whatever
merchant it named, so four junk payments anywhere refused every other merchant,
and two honest buyers of one merchant could not pay at once. Four checks per
merchant with no cap across merchants fixed that, but well-formed payments
signed with noise could still fill a merchant's four places, each for a round
trip to the facilitator, so the checks split into the two lanes above.

Fair sharing of the gate between sources, a separate room for agents signed
under directories other parties vet, a lane for agents that sign a payment
before the price, a reserved place in the SDK's handlers and a rate limit at
the edge in front of the gateway through Cloudflare are kept for later, when
abuse or a merchant whose gate is often full is seen. The product owner wants
Cloudflare later as the outer layer. If it is added, only per-address rate
limits fit: challenges and bot-fight modes would refuse honest agents, which
are programs.

For WooCommerce, a new cart per price leaves a session in the shop for every
question; a single shared pool of carts let free questions take the carts a
paid parcel needed; and stopping a shop's sales for good once its carts are in
doubt turned a transient failure into a permanent one, when an unknown change
only forbids reusing that cart.

## Remaining measurements and operational questions

Shop capacity, the distribution of response times, real cart expiry and the
shop's own session cleanup remain unmeasured. Isolation of the shared database
and facilitator, the facilitator's quotas and fairness between callers are in
[open questions](00-open-questions.md). The gate's constants are not a capacity
benchmark. The tests establish bounded admission and the order of selection;
they do not establish completed payments on the live channel.
