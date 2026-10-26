# Unpaid price questions: what the world knows

Desk research of 2026-10-26. It informs a later decision on the unpaid side of
a purchase and decides nothing itself. Every market fact carries its source;
what is my own reading or arithmetic is marked as such.

## The question

A purchase through Agentify begins with an anonymous `POST` that carries a
card's parameters and no payment. For a card with a price check, Agentify then
asks the merchant for the price before it answers with HTTP 402 and the payment
requirements, and that price stands for thirty seconds. A merchant selling
through the SDK answers in their own process, which holds at most four
messages at once and whose price answer counts as silent after five seconds
([83-worker-throughput](83-worker-throughput.md),
[What can go wrong](../../apps/docs/failures.md)). A merchant selling through
the WooCommerce connector is asked inside Agentify, which calls the shop on the
merchant's behalf: one price question reads the product and eleven settings
through the authenticated `wc/v3` API, and a parcel's question adds two
shipping-rate reads through the shop's anonymous Store API cart, each of them
one `GET` and two `POST` calls, so a parcel's price is eighteen calls to the
shop from Agentify's one address (`inspectProductInTheShop` and
`shippingRatesInTheShop` in `apps/dashboard/src/woo-shop.ts`). A card with a
fixed price asks nobody.

To protect the shop, [ADR-0043](../decisions/0043-the-purchase-door-refuses-before-any-charge.md)
lets a merchant have only a limited number of purchases priced and unpaid at
once, and refuses every purchase beyond it with `seller_busy` before its price
is asked. Anybody can therefore keep that many purchases open, pay for none of
them, and stop the merchant's sales through Agentify while they do. The product
owner has rejected that outcome: no way to stop a merchant's sales without
paying should exist, and Agentify should not become a firewall standing in
front of the merchant. The product owner asked whether anyone in the world has
already thought about this, how existing agentic sales over x402 are built,
whether anyone can send an unlimited number of price requests, how the merchant
itself survives such load, and whether lower-level filters on the side that
serves the agent could do the job instead.

One observation of mine frames everything below, and it is analysis rather
than a source. The limit does not create the way to stop sales; it chooses
where the stopping happens. Without it, a flood of unpaid purchases fills the
four places of an SDK merchant's process, so that honest buyers' price
questions go unanswered within five seconds and their purchases fail, or it
reaches the shop's own bot protection, which bans Agentify's one address and
fails every buyer at once (section "How shops survive" below). Any free request
that spends something the merchant has a bounded amount of is a free way to
stop the merchant. The options at the end are compared on what an attacker
still gets for nothing under each.

## What is established

### x402: the challenge is free, computed per request, and unbounded by the protocol

The x402 repository now lives under the x402 Foundation, which moved under the
Linux Foundation on 2026-04-02
([announcement](https://www.linuxfoundation.org/press/linux-foundation-is-launching-the-x402-foundation-and-welcoming-the-contribution-of-the-x402-protocol)).
Its version 2 specification answers 402 to any request that carries no valid
payment and sets no limit on how often anyone may ask; its security section
covers replay and sign-in, not denial of service
([specification](https://github.com/x402-foundation/x402/blob/main/specs/x402-specification-v2.md)).
I found no guidance on rate limiting, flooding or abuse of the unpaid request in
the core specification, the HTTP transport or the `exact` and `upto` scheme
files. The only mention of rate limits in the specifications is in Cloudflare's
binding, where they are terms agreed at registration
([binding](https://github.com/x402-foundation/x402/blob/main/specs/schemes/batch-settlement/scheme_batch_settlement_cloudflare.md)).
The HTTP transport tells servers to keep the 402 out of shared caches, and the
reference server sends `Cache-Control: no-store` on every one
([transport](https://github.com/x402-foundation/x402/blob/main/specs/transports-v2/http.md)).

In the reference server, a route's price is either fixed or a function of the
request, and `processHTTPRequest` builds the payment requirements, calling that
function, on every request before it looks for a payment header. The paid retry
builds them again from scratch and matches the payment against the fresh copy,
so a seller with a dynamic price computes it at least twice per purchase and
keeps no quote between the two
([`x402HTTPResourceServer.ts`](https://github.com/x402-foundation/x402/blob/main/typescript/packages/core/src/http/x402HTTPResourceServer.ts),
read at `main` on 2026-10-26). The one place to refuse a request before that
work is a hook, `onProtectedRequest`, which can abort with 403; the SDK ships
no limiter of its own. The official example of a dynamic price reads a query
parameter inside the price function
([example](https://github.com/x402-foundation/x402/blob/main/examples/typescript/servers/advanced/dynamic-price.ts)),
and one e-commerce integrator reports a price computed from the `POST` body
running in production
([issue 999](https://github.com/x402-foundation/x402/issues/999), no replies).
A third-party Laravel package, in alpha, puts a throttle of sixty requests per
address per minute in front of its payment middleware
([package](https://packagist.org/packages/sandermuller/laravel-x402)). I found
no x402 seller documented as calling a shop's backend for its price on the
unpaid request, which is what the WooCommerce connector does.

Variable prices exist in x402 without removing the step we have. The `upto`
scheme lets the payer sign for a maximum and be charged the actual amount, at or
below it, after the work is done; it is specified for EVM through Permit2 only,
not through the `transferWithAuthorization` signature Agentify verifies today
([upto](https://github.com/x402-foundation/x402/blob/main/specs/schemes/upto/scheme_upto.md),
[EVM binding](https://github.com/x402-foundation/x402/blob/main/specs/schemes/upto/scheme_upto_evm.md)),
and Coinbase's facilitator settles it ([facilitator](https://docs.cdp.coinbase.com/x402/seller/facilitator.md)).
The 402 still has to name the maximum. A scheme for negotiated prices over
several rounds was proposed and closed without merging on 2026-06-02
([PR 628](https://github.com/x402-foundation/x402/pull/628)). The x402 Bazaar
describes itself as in early development with free listing, and its catalogue
records the requirements seen at payment time rather than a live price
([Bazaar](https://github.com/x402-foundation/x402/blob/main/docs/extensions/bazaar.mdx)).

Cloudflare's binding of the `batch-settlement` scheme is the one x402 text that
ties price disclosure to identity. A client signs its requests with HTTP Message
Signatures (RFC 9421) under a key directory Cloudflare knows, and the binding
says the amount may be missing from a 402 and is guaranteed only when the
signing agent is recognised
([binding](https://github.com/x402-foundation/x402/blob/main/specs/schemes/batch-settlement/scheme_batch_settlement_cloudflare.md)).
I did not establish whether this runs beyond Cloudflare's pay-per-crawl beta.

### Other payments over HTTP 402

The nearest precedent for our problem is on Lightning. Aperture, Lightning
Labs' L402 proxy, creates an invoice for every unpaid request and can ask an
external price server per service before it issues the challenge
([README](https://github.com/lightninglabs/aperture/blob/master/README.md)).
An issue of 2026-01-15 says an attacker can spam requests without valid tokens
and drain the server because invoice creation is expensive, and asks for rate
limiting by address on challenge creation; it was closed as completed on
2026-02-06 ([issue 202](https://github.com/lightninglabs/aperture/issues/202)).
I have not read the change that closed it. Proof of work and proof of owning an
on-chain output are proposed there as alternative admission tickets and are
still open ([issue 192](https://github.com/lightninglabs/aperture/issues/192)).

Stripe and Tempo describe their payment scheme in an individual Internet-Draft
of 2026-09-09, which has no IETF standing. It says servers should rate-limit
challenges issued and credential checks, requires a challenge's identifier to be
bound to the request (an HMAC over its fields is the recommended way, so the
server keeps nothing per challenge), and requires `no-store` on the 402
([draft-httpauth-payment-01](https://datatracker.ietf.org/doc/draft-httpauth-payment/)).
Skyfire has no quote step at all: the buyer mints a token whose amount is a
maximum, minting commits that amount against the buyer's wallet, and a seller's
service is reviewed before buyers can mint for it
([seller services](https://docs.skyfire.xyz/docs/seller-services)). Nevermined
returns 402 without a token and spends through a delegation with a limit; its
page describes no rate limiting
([docs](https://nevermined.ai/docs/development-guide/nevermined-x402.md)).

### Agentic commerce protocols bound unpaid work by who may call

None of the neighbouring protocols I read sets a bound on unpaid sessions or
quotes. They avoid the question by deciding who may call the merchant at all.

The Agentic Commerce Protocol of OpenAI and Stripe defines checkout sessions
that are created, updated and completed against the merchant's endpoints,
authenticated by a bearer key, with an idempotency key on every `POST`; the
specification has no 429 response and sets no session lifetime
([specification](https://github.com/agentic-commerce-protocol/agentic-commerce-protocol)).
A merchant gives each platform it onboards its own key, so no agent calls
anonymously, and ChatGPT is the only platform named
([agenticcommerce.dev](https://www.agenticcommerce.dev/)). In March 2026
OpenAI let merchants use their own checkout and turned its attention to product
discovery ([OpenAI](https://openai.com/index/powering-product-discovery-in-chatgpt/)).
Google's Agent Payments Protocol has the merchant sign the checkout before the
user or agent commits anything, so unpaid pricing work is part of the design,
and it sets no rate limit; agents are identified by keys and a trust list of
agent providers that is not specified further
([AP2 specification](https://ap2-protocol.org/ap2/specification/)). Its x402
extension is a version 0.1 specification with a Python library
([a2a-x402](https://github.com/google-agentic-commerce/a2a-x402)). The
Universal Commerce Protocol signs every request with RFC 9421 and has an error
for a platform that is not on the merchant's list of approved platforms
([UCP signatures](https://ucp.dev/latest/specification/signatures/)).

The card networks register agents before they transact. Visa's Trusted Agent
Protocol signs the agent's requests with RFC 9421 under keys in a directory Visa
runs, and the merchant or its CDN verifies an Ed25519 signature
([Visa developer](https://developer.visa.com/capabilities/trusted-agent-protocol/trusted-agent-protocol-specifications),
[sample code](https://github.com/visa/trusted-agent-protocol)); Visa reported
live agent transactions in Europe on 2026-07-02
([Visa](https://www.visa.co.uk/about-visa/newsroom/press-releases.3457328.html)).
Mastercard Agent Pay registers agents and issues them tokens, uses the same
signature standard, and its guide says a merchant whose CDN lacks support can
verify the signature in its own backend
([Mastercard guide](https://developer.mastercard.com/merchant-cloud/documentation/tutorials-and-guides/agentic-commerce-guide/21/)).

### Agent identity: verifiable today, and by whom

Web Bot Auth is the common layer under most of the above: an agent signs its
HTTP requests and publishes its keys at a well-known address. The IETF working
group has one document, of 2026-09-01, and its charter puts out of scope HTTP
APIs and agent-to-agent interfaces, the end user behind an agent, and tracking
or assigning reputation to bots; its milestone of 2026-04-30 has passed
([charter](https://datatracker.ietf.org/wg/webbotauth/about/),
[draft](https://datatracker.ietf.org/doc/draft-ietf-webbotauth-httpsig-protocol/)).
Verification needs no CDN: Cloudflare publishes open libraries, marked as not
audited, that any origin can use
([web-bot-auth](https://github.com/cloudflare/web-bot-auth)), and ChatGPT's
agent signs as `https://chatgpt.com`
([OpenAI help](https://help.openai.com/en/articles/11845367-chatgpt-agent-allowlisting)).

A signature proves only that the request came from whoever holds the key. What
gives it weight is a party that vetted the key: Visa's or Mastercard's
directory, or Cloudflare's review. Since 2026-07-01 Cloudflare counts signed
agents among its verified bots, admitted by a reviewed submission
([signed agents](https://developers.cloudflare.com/bots/concepts/bot/signed-agents/)).
Its policy has a category for checkout on behalf of users and a label for an
intermediary that many end users operate, notes that a site may trust the
operator without trusting every user behind it, and says Cloudflare is
experimenting with forwarding the end user in the `Forwarded` header; it asks
for "reasonable request rates" and names no number
([verified bots policy](https://developers.cloudflare.com/bots/concepts/bot/verified-bots/policy/)).

Identity that its holder issues to themselves costs nothing and therefore bounds
nothing. That covers a self-hosted Web Bot Auth directory, x402's
Sign-In-With-X, which proves control of a wallet and can admit a route on the
signature alone ([SIWX](https://docs.x402.org/extensions/sign-in-with-x)), and
the on-chain agent registries of ERC-8004, whose text itself says Sybil attacks
are possible ([EIP-8004](https://eips.ethereum.org/EIPS/eip-8004)). Skyfire's
token is vendor-issued and its buyer platforms are vetted
([security brief](https://docs.skyfire.xyz/docs/security-brief-for-sellers)).
I found mutual TLS or workload identity for agents only inside enterprises, and
no commerce protocol that uses it between an agent and a merchant.

### How shops survive, and what it does to an intermediary

WooCommerce has a rate limiter for the Store API, and it is off unless the shop
turns it on with a filter. Its defaults when on are 25 requests in 10 seconds,
counted per logged-in user or per IP address, with `RateLimit-*` headers; the
documentation says only `POST` requests are counted
([rate limiting](https://developer.woocommerce.com/docs/apis/store-api/rate-limiting/)),
while my reading of the current source finds the method check only on the
separate checkout switch
([`Authentication.php`](https://github.com/woocommerce/woocommerce/blob/trunk/plugins/woocommerce/src/StoreApi/Authentication.php)),
so I do not know whether a `GET` counts once the filter is on. The answer
changed from HTTP 400 to 429 in WooCommerce 11.2
([PR 68066](https://github.com/woocommerce/woocommerce/pull/68066)), so a shop
on an older release refuses with 400 and the error code `rate_limit_exceeded`.
A separate setting, added in 9.6 and off by default, limits checkout to three
per minute per address
([PR 53711](https://github.com/woocommerce/woocommerce/pull/53711)). Since 9.8 a
filter lets a plugin choose what the limit is keyed on
([PR 55209](https://github.com/woocommerce/woocommerce/pull/55209)). I found no
built-in limit on the `wc/v3` API that consumer keys use; there the host decides.

For the connector this means, by my arithmetic, that a shop with the limiter on
holds every buyer Agentify serves to one shared count of 25 per 10 seconds,
which at four Store API `POST` calls per parcel price is about six parcel
prices in ten seconds, whoever the buyers are.

The heavier protection sits in front of WordPress. Kinsta's bot protection
blocks or challenges non-verified APIs at its stricter levels and leaves the
allowance for `/wp-json/` automations off by default
([Kinsta](https://kinsta.com/docs/wordpress-hosting/mykinsta-tools/wordpress-tools-bot-protection/)).
SiteGround answered a monitoring service's fixed address with a captcha page
under HTTP 202, which needs support to lift
([mySites.guru](https://mysites.guru/blog/siteground-captcha-blocking-mysites-guru/)).
Cloudflare's free Bot Fight Mode cannot be skipped by WAF rules and may
challenge API traffic
([Bot Fight Mode](https://developers.cloudflare.com/bots/get-started/bot-fight-mode/)).
Integrations that call WooCommerce shops from fixed servers all meet this the
same way: Printful's was blocked until merchants exempted its user agent
([forum](https://wordpress.org/support/topic/http-error-403-could-not-open-woocommerce-authorization-page/)),
and Stock Sync, OneCart and Apideck ask merchants to allow their addresses or
paths in the firewall
([Stock Sync](https://help.stock-sync.com/en/article/how-to-resolve-woocommerce-api-errors-caused-by-firewall-blocking-14v7e20/),
[OneCart](https://www.getonecart.com/help/handling-cloudflare-blocks/),
[Apideck](https://developers.apideck.com/apis/ecommerce/woocommerce/connection)).
An exemption of that kind is the merchant's act, not the intermediary's, and it
switches the protection off for whoever can make their traffic look like
Agentify's.

Our own census of WooCommerce shops shows how common that front is among the
merchants Agentify looks for. Cloudflare stands in front of 45% of the 29
Indonesian shops it counted, none of them blocked the single catalogue request
the census sent, and about one in eleven of all the sites it requested answered
the front page with a Cloudflare challenge
([55-woo-shop-census](55-woo-shop-census.md)). One request per shop says
nothing about what happens under volume, which is when a limiter or a bot score
acts.

Shopify is the one platform I found that addresses one address serving many
buyers. Its Storefront API puts no fixed limit on real buyers' requests, limits
bots most strictly when they are unsigned, and asks a server acting for buyers
to pass each buyer's address in `Shopify-Storefront-Buyer-IP`, without which it
cannot tell buyers apart; signed bots get higher limits with no Cloudflare
enrolment ([Storefront API](https://shopify.dev/docs/api/storefront),
[changelog of 2026-05-07](https://shopify.dev/changelog/bots-and-agents-should-identify-themselves-via-web-bot-auth)).
WooCommerce has no equivalent header.

### Payment first: what verifying costs and what it reserves

Coinbase's facilitator says payment verification is always free and charges
only for transactions on chain
([facilitator](https://docs.cdp.coinbase.com/x402/seller/facilitator.md)). The
specification forbids verification to write any state
([specification](https://github.com/x402-foundation/x402/blob/main/specs/x402-specification-v2.md)),
and the `exact` scheme on EVM checks the signature and the balance and simulates
the transfer ([exact EVM](https://github.com/x402-foundation/x402/blob/main/specs/schemes/exact/scheme_exact_evm.md)).
An EIP-3009 authorization is a signature made off chain, which its signer can
cancel ([EIP-3009](https://eips.ethereum.org/EIPS/eip-3009)). By my reading of
these, one wallet holding one price's worth of USDC can sign any number of
authorizations with fresh nonces, and each passes verification against the same
balance until a settlement drains it; I found no x402 text that reserves a
balance across concurrent authorizations. A paper of May 2026 found, in official
SDKs and a production deployment, a race that settles one authorization twice,
concurrent `upto` requests that all clear verification against one snapshot of
an allowance, and verification that admits a burst which settlement then
refuses; it proposes locking nonces, reserving before committing, and failing
closed ([Free-Riding the Agentic Web](https://arxiv.org/abs/2605.30998)).

## Announced but not shipped

Cloudflare's Monetization Gateway, announced on 2026-07-01 with a waiting
list, would verify x402 payments at the edge and could optionally require Web
Bot Auth ([blog](https://blog.cloudflare.com/monetization-gateway/)).
Cloudflare Wallets, announced on 2026-08-04, would give agents an optional
persistent identity built on Web Bot Auth
([blog](https://blog.cloudflare.com/wallets/)). American Express announced
agent registration in its developer kit on 2026-04-14
([Amex](https://www.americanexpress.io/building-trust-in-ai-powered-transactions-with-amex-agentic-commerce-experiences/)),
Akamai an agentic security framework with Visa, Skyfire and Experian
([Akamai](https://www.akamai.com/newsroom/press-release/akamai-unveils-agentic-security-framework-to-power-trusted-ai-driven-interactions-and-commerce)),
and Worldpay with Trulioo a digital agent passport
([Worldpay](https://www.worldpay.com/en/press-releases/worldpay-and-trulioo-collaborate-embed-trust-agentic-commerce)).
Anonymous credentials that would let a site rate-limit an agent without
learning who it is are drafts: Privacy Pass's anonymous credit tokens, which
Google and Cloudflare say they are exploring for rate-limiting agents
([slides](https://datatracker.ietf.org/meeting/124/materials/slides-124-privacypass-anonymous-credit-tokens-00)),
and an anonymous variant of Web Bot Auth whose authors say its resistance to
Sybil attacks rests entirely on how the issuer vets
([draft](https://datatracker.ietf.org/doc/html/draft-rescorla-anonymous-webbotauth-01)).
A seller-issued nonce bound to the request was proposed for x402 on 2026-10-22
([issue 3873](https://github.com/x402-foundation/x402/issues/3873)).

## What nobody seems to have solved

I found nobody who lets an anonymous party, with no platform behind it, ask for
a price that costs the merchant real work, as often as it likes, without that
being a way to hurt the merchant. The protocols that price expensively before
payment keep anonymous callers out (the Agentic Commerce Protocol, the card
networks, Skyfire). The ones open to anonymous callers either price cheaply,
as most x402 sellers do from a static route, or put a rate limit by address or
identity in front of the challenge, as Aperture and the Stripe and Tempo draft
do. A limit by address is cheap to evade and, applied by the shop to an
intermediary, punishes every buyer behind it. Nobody publishes a bound on a
merchant's priced and unpaid orders like ours, so that limit is our own
invention, and I found no measurement anywhere of how often free price
discovery is abused in agentic commerce. I do not know whether that is because
it does not happen yet or because nobody prices expensively enough for it to
matter.

## The options against the principle

The principle is that nobody can stop a merchant's sales without paying. The
options below are compared on what each still leaves an attacker for nothing.
They are not exclusive, and the choice is the product owner's.

### Keep the limit as it is

One stranger with a script stops a merchant's sales through Agentify, without a
wallet, for as long as the script runs. The shop is protected; the principle is
not met.

### Answer a repeated question from the price already given

The merchant's answer stands for thirty seconds, so the same card with the same
parameters could be answered from it for that time, and the merchant asked at
most once per distinct question. This is my idea, not a practice I found
anywhere; x402's `no-store` concerns shared caches between client and server,
not a server reusing its own answer. An attacker who varies the parameters, such
as the place a parcel goes, still reaches the merchant once per variation, so
this narrows the free load to the number of distinct questions and does not
close it.

### Give known agents their own room

A door can verify an agent's Web Bot Auth or Trusted Agent signature itself,
with open libraries, and count requests signed under directories run by others
(Visa, Mastercard, Cloudflare's verified agents, ChatGPT) apart from anonymous
ones. An attacker could then no longer stop sales to those agents for free,
because entering those directories takes review or registration. Anonymous
agents would still share a room that anybody can fill, so an agent with no
platform could still be shut out for free. A self-issued key or wallet sign-in
gives nothing here. Whether counting by identity is "a firewall in front of the
merchant" is the owner's call; it is an admission policy, the same kind Shopify
applies.

### Ask the merchant only after a signed payment authorization

The agent would sign before the price question, for a maximum, as `upto` allows,
and the merchant would be asked only then. This moves the cost from nothing to
holding one price's worth of USDC, since verification is free and reserves
nothing; one funded wallet can sign without limit, and an authorization the
price refuses (an agent that signs for one cent below every real price) is again
free. Only if Agentify counts a wallet's outstanding authorizations against its
balance, the reserve-then-commit of the paper above, does holding N purchases
open cost N prices locked, and even then the money is held, not spent. It also
changes what an agent must do before it sees a price: `upto` on EVM needs a
Permit2 approval, which is not the signature Agentify verifies today.

### Charge for the price question itself

A small x402 payment for the question, credited against the purchase when it
follows, would make stopping a merchant cost the attacker money for every thirty
seconds of every purchase they hold open, which is the principle read literally.
It also makes every honest agent pay before seeing a price. I found no commerce
precedent; the nearest are pay-per-request APIs and proof of work, which is only
proposed. The economics of tiny x402 payments are in
[36-zero-price](36-zero-price.md).

### Leave the shop to protect itself

The merchant's host, CDN or Store API limiter does the filtering, and Agentify
only reports a refused price question as a refusal with nothing charged. This
keeps Agentify out of firewall logic entirely, and it is exactly the failure
ADR-0043 was written against: the shop's protection sees one address, and an
attacker who trips it shuts out every buyer of that shop at once. Without a
buyer header like Shopify's, the shop cannot tell buyers apart.

## What I do not know

Whether real agents today sign with Web Bot Auth often enough for the known
agents' room to matter; I found ChatGPT's agent signing and no counts for
anyone else. Whether Cloudflare's verified bots pass its free Bot Fight Mode; I
found no primary statement. Whether WooCommerce's limiter counts `GET` requests
once a shop turns it on. Whether Cloudflare's identity-gated price is live
beyond pay-per-crawl. And at what volume of calls from Agentify's address the
protection in front of a typical shop starts to refuse: the census sent one
request per shop, and nobody has measured more.
