# Recorded answers of services Agentify does not run

A test that stands in for a service Agentify does not run states facts about
that service: which currencies an exchange-rate feed lists, which error a shop
sends, which refusal codes a facilitator uses. Nothing compared those facts
with the services, so a test could be right about the code and wrong about the
world. Three tests said Coinbase gives no rate for a currency it does rate
(XAF twice, IDR once), and a WooCommerce stand-in answered an expired cart
token with an error code the Store API's cart route never sends. The charter's
rule is that a stand-in says only what the service was seen to answer, kept
with its source and the date it was read (`AGENTS.md`, Code). This note
describes the one place those answers are kept, the check that asks the
services again, and the stand-ins that are not recorded yet.

## What is recorded

`packages/recorded` (the workspace package `@agentify/recorded`) holds the
answers as JSON files beside one module that reads them. Tests import the
module, and the live check imports the same module, so a fact exists once.
Each file says where its answer came from and when it was read.

Coinbase's public exchange rates are kept as two whole answers. The first is
the answer to `GET https://api.coinbase.com/v2/exchange-rates?currency=USD`,
read on 2026-10-21 at 14:52:48 UTC, which the dashboard's reference rate is
read from. The second is the answer for a base currency Coinbase does not
know, asked as `?currency=XXX` on 2026-10-30: HTTP 400 with
`{"error":"base currency not recognized","code":3,"message":"base currency not recognized"}`.
Tests build their stand-ins from these answers and take the rupiah's rate
from the first through `coinbaseRateOf`; the dashboard's tests read the first
through the dashboard's own reader (`apps/dashboard/src/testing/coinbase.ts`).
A currency
the recording does not list makes `coinbaseRateOf` throw, so a test cannot
name a rate Coinbase did not give. A test that needs a currency Coinbase does
not rate uses IRT, the Iranian toman, which WooCommerce offers a shop and
Coinbase does not list. The arithmetic tests of `woo-money.test.ts` keep the
rupiah's rate as their own number: there it is only an input to a sum, and a
new recording should not change their expected results.

WooCommerce is recorded from the source of one release, 11.2.1, read on
2026-10-30 from `raw.githubusercontent.com/woocommerce/woocommerce/11.2.1/`.
The recording holds the 164 currencies of `plugins/woocommerce/i18n/currencies.php`
and, for each WooCommerce error code that Agentify's connector or its tests
name, the statement in the source that produces it, with its status and
message: `woocommerce_rest_missing_nonce` (401) and
`woocommerce_rest_invalid_nonce` (403) from the Store API's cart route,
`woocommerce_rest_product_out_of_stock` (400) and
`woocommerce_rest_cart_item_error` (an entry in a cart's errors, with the
words of the notice that raised it) from its cart controller,
`woocommerce_rest_product_invalid_id` and
`woocommerce_rest_shop_order_invalid_id` (404, written with the controller's
post type, whose statement is recorded too),
`woocommerce_rest_required_product_reference` (400) from the orders
controller, and `rest_setting_setting_group_invalid` (404) from the settings
controller. `wooRefusal(code)` gives a test the answer a shop sends for one of
these codes and throws for any other.

The payment facilitator's refusal vocabulary is recorded from the npm
tarballs of the versions the gateway pins, read on 2026-10-30. From
`@coinbase/cdp-sdk` 1.55.0 come the 195 codes of `X402VerifyInvalidReason`
and the 214 of `X402SettleErrorReason`, as its generated client declares them.
From `@x402/evm` 2.23.0 come the 59 codes of the reference facilitator's exact
scheme for EVM chains, declared in `src/exact/facilitator/errors.ts`, which the
tarball carries inside the source map of `dist/cjs/exact/facilitator/index.js`.
No test reads these lists yet. The live check holds the gateway's refusal
table (`apps/gateway/src/adapters/x402/refusal-codes.ts`) against the
verification codes only, because the gateway reads the table only when a
verification is refused. A refused settlement is an unknown outcome whatever
its code, except for two codes that show nothing was broadcast. Coinbase names
its settlement list apart, so the recording marks `X402SettleErrorReason` as
settlement. The x402 file declares
verification and settlement codes together and does not say which a
verification can carry: its first block has no label, and two codes it files
under settlement, `smart_wallet_deployment_failed` and
`unsupported_payload_type`, are among Coinbase's verification reasons. The
check therefore counts every code in that file as a possible verification
code. Five of them appear in neither of Coinbase's lists and could be either:
`asset_not_deployed_contract`, `invalid_exact_evm_transfer_event_mismatch`,
`invalid_transaction_state`, `eip6492_factory_not_allowed` and
`settlement_pending`; the table reads all five.

The facilitator recording also keeps a short list of codes awaiting a
decision: codes a newer version names that the table does not read, each with
the version and the date it was first seen, until the product owner decides
how the gateway reads them.

## How the live check runs

`pnpm smoke:recorded` asks every recorded service again with public GET
requests, a handful to each, which need no key or sign-in and spend nothing. A
scheduled workflow (`.github/workflows/recorded.yml`) runs it every Monday and
can be started by hand. It never runs on a pull request, since what it reports
is the world moving, which no change under review causes. It reads nothing
secret. For every fact it prints the fact, its source, the recorded value and
the live one, and whether the fact holds, changed, or could not be checked.
A fact that changed fails the run, and so does a service that could not be
asked, but the output names the two apart. No answer, a refusal to answer
(401, 403, 429 or a server error) and a page that is not the JSON the service
sends, such as a challenge page in front of Coinbase, all read as "could not
check" and never as a change. GitHub sends a failed scheduled run to whoever
last changed the workflow's cron line, and disables the workflow after 60
days without activity in the public repository, after which it runs again
only once someone turns it back on in the Actions tab.

For Coinbase it asks for the US dollar's rates and checks that Coinbase still
rates exactly the WooCommerce currencies it rated when recorded; a currency a
shop can price in that Coinbase starts or stops rating fails the run. The
other codes Coinbase lists, most of them crypto tokens that come and go, are
reported without failing, and the rates themselves are not compared, since
they move. It also asks for the unknown base currency and compares the status
and the shape of the error body.

For WooCommerce it reads the recorded release's files and checks that each
recorded statement, with its whitespace collapsed, is still there, and that the
currency list is the same. It then asks WordPress.org for the newest
WooCommerce release and, when that is a newer one, reads the same files at the
newest release's tag and checks every recorded fact there too. A fact that no
longer holds in the newest release, because a code, its status, its message or
the whole statement is gone or changed, or the currency list differs, fails
the run, naming the fact and the release. A newer release in which every
recorded fact holds is reported without failing, so that a person decides
when to move the recording to it. The recorded release alone could never fail
after its first run, since a tag's files do not change; the newest release is
where WooCommerce moves. It asks no live shop.

For the facilitator it reads the recorded lists again from the pinned
tarballs and checks that the gateway still pins those versions. It then reads
the newest published version of each package and compares its verification
codes with the recorded ones, because the hosted facilitator answers with its
current codes whatever version the gateway pins. A new verification code the
table reads as unrecognised fails the run unless it is on the list of codes
awaiting a decision, and so does a verification code the table reads that the
newest version drops. A code awaiting a decision is reported on every run
until it is decided. When the table comes to read such a code, or the newest
version stops naming it, the run says so, so that the list does not keep codes
that no longer wait for anything. Changes to settlement codes are reported without
failing. A code that only names a payment the gateway does not offer (Permit2,
an ERC-20 approval, EIP-2612, batch settlement, the `upto` scheme, Solana,
sign-in with x) is left alone. The check finds the table's codes among the
string literals of its source file, so a code moved to another file goes
unseen.

The check has no tests of its own; negative controls prove it. With XAF
removed from Coinbase's recording it fails, naming XAF as a currency Coinbase
now rates. With a WooCommerce statement rewritten to a code the release does
not contain, it fails, naming the statement it cannot find. With every request
sent to a closed port it reports each fact as not checked and exits with
status 2 rather than 1, as it does when a local server answers in Coinbase's
place with a 403 or with a challenge page. With WooCommerce 9.9.0 standing in
for the newest release it fails on the out-of-stock refusal, whose recorded
statement 9.9.0 does not contain, and on the currency list, whose file
WooCommerce added later; with 11.2.0 standing in, every fact holds and the run
only reports the release. With `node_failure` taken off the list awaiting a
decision it fails on that code, while the x402 code on the list is only
reported.

## What the first run found

On 2026-10-30 every recorded Coinbase and WooCommerce fact held, and Coinbase
listed three tokens it did not list on 2026-10-21 (RITUAL, RLUSD and STABLE),
none of them a currency a shop can price in. WooCommerce 11.2.1 was the newest
release.

The facilitator's verification codes have moved past the gateway's table.
`@coinbase/cdp-sdk` 1.60.0 adds `node_failure` to the verification reasons,
and the table reads it as unrecognised, while it reads the facilitator's other
reports of its own failure as no verdict. `@x402/evm` 2.29.0 adds
`invalid_exact_evm_non_canonical_signature`, which the table also reads as
unrecognised. Both were first seen on 2026-10-30 and are recorded as awaiting
the product owner's decision, so each run reports them and passes. Every code
the table reads is named by one of the recorded verification lists, and every
verification code they name that belongs to the exact payment the gateway
offers is one the table reads.

## Stand-ins not yet recorded

The tests below state facts about outside services that nothing records
yet.

### Coinbase's hosted facilitator

The gateway's start-up probe of a facilitator key assumes that Coinbase
answers an empty payment signed with a known key with 400, an unknown key
with 401, a key whose allowlist excludes the server with 403, and that a 2xx
or 422 also means the key passed (`apps/gateway/src/adapters/x402/client.test.ts`,
`facilitator-key-check.test.ts`). The facilitator tests also assume that a
verdict can arrive with a refusing status, that a server error carrying a body
is no verdict, and that 401, 403 and 404 refuse the caller
(`facilitator.test.ts`). None of this can be read without Coinbase's
credentials. The way to record it is one credentialed run of the existing
facilitator smoke command that saves each status and body with its date; a
scheduled re-read would need the key in a workflow.

The same tests name about forty refusal codes by hand. They all appear in the
recorded vocabulary, so moving them onto it would only make that visible. The
claim that an empty wallet is refused with
`invalid_exact_evm_transaction_simulation_failed` was observed and not
recorded; the public facilitator at `x402.org/facilitator` needs no key and
would show it for a payment signed by an unfunded throwaway key on Base
Sepolia, which is a POST but moves no money. `amount_too_low` for a payment of
a millionth of a dollar is recorded in prose in `36-zero-price.md`, without
the raw answer.

### The x402 Bazaar

The discovery walk in `packages/slice` assumes the catalog's paging: `limit`
honoured up to 1,000, `offset` rounded down to a multiple of it, search
parameters ignored. A GET of
`api.cdp.coinbase.com/platform/v2/x402/discovery/resources?offset=1500&limit=1000`
confirms the paging and gives `pagination.total`, which on 2026-10-30 was
104,692 against the walk's ceiling of 200 pages of 1,000. The listing check's
stand-in for the validate endpoint (`listing-command.test.ts`,
`listing-check.test.ts`) is a keyless POST that a scheduled job could make.

### Base, its RPC and USDC

Recovery and payment tests assume that a public RPC refuses or narrows
`eth_getLogs`, serves `eth_getBlockReceipts` and the `finalized` block, reports
a revert as JSON-RPC error 3, and answers a rate limit with HTTP 429. Only the
revert matters to a verdict: a provider that reports reverts another way would
turn a verdict into no answer. All of it is free to read with JSON-RPC POSTs to
`sepolia.base.org` and `mainnet.base.org`, recorded in the style of
`packages/slice/src/commission-wallet.rpc.json`. USDC's name and decimals on
Base Sepolia can be read with a GET from Blockscout; its EIP-712 version needs
an `eth_call`.

### Coinbase Wallet and the Base Account SDK

The wallet tests use EIP-1193 and EIP-5792 codes, which are standards, and the
wording of a lost session, which is in `@base-org/account` 2.5.13's source and
could be read from its npm tarball the way the facilitator's codes are.

### WooCommerce and WordPress

Several codes a WooCommerce shop sends come from WordPress, not WooCommerce:
`rest_no_route` (404), which the connector reads to learn that a shop has no
fulfilment route, `rest_invalid_param` (400), which it reads as a place the
shop will not ship to, and `rest_forbidden`. The status of
`woocommerce_rest_cannot_view` is WordPress's too: 401 for a request that did
not authenticate, which is how a deleted key reaches the controller over
HTTPS, and 403 for a key whose user lacks the permission. These can be read
from the source of a WordPress release on GitHub, pinned the way WooCommerce
is. `rest_cannot_access`, used for a shop that closes its REST API, belongs to
a plugin and has no single source.

The tests that name a recorded WooCommerce code still write most of them by
hand: `woocommerce_rest_missing_nonce`, `woocommerce_rest_invalid_nonce`,
`woocommerce_rest_product_out_of_stock`, `woocommerce_rest_cart_item_error`,
the two `invalid_id` codes and `rest_setting_setting_group_invalid` in
`woo-shop.test.ts`, `woo-worker.test.ts` and `woo-recovery.test.ts`. Moving them
onto `wooRefusal` is mechanical. The shapes of the Store API's cart, the
orders a shop creates and its settings are transcribed by hand from the tax
probe (`56-woo-tax-probe/results.txt`) and the parcel probe
(`41-woo-parcel-probe.md`); recording them needs the WooCommerce lab at the
recorded release, which runs in Docker and costs nothing. Three claims have no
source at all: that a protected download refuses an anonymous fetch and
serves `Range: bytes=0-0` with 206, that some shops' firewalls refuse a
request without a User-Agent, and that WooCommerce keeps `tax_status` at
`taxable` with tax switched off. The lab can answer the first and the last.

### Sign-in, mail and the rest

Google's endpoints and claims in the sign-in stand-in
(`apps/dashboard/src/testing/google.ts`) can be read with a GET of
`accounts.google.com/.well-known/openid-configuration`. Resend's meaning of
each status (`mail.test.ts`) is on its public errors page, which a GET can
read; the one-day window of its idempotency key is in its documentation.
Cloudflare Turnstile's answer (`turnstile.test.ts`) can be read with a POST
using Cloudflare's published test secret. GitHub's workflow-run filters in the
release command's tests are a free GET. The statuses the ad tracker and Nuanu
Analytics are assumed to answer with (`ad-reports.db-test.ts`,
`nuanu-analytics.db-test.ts`) have no specification in the repository and
need a key to read; the useful step is to write down, with a date, what their
owners say each status means. Meta's and PostHog's answers and Apify's run
states are documented by those services and matter only to scanner features
that are off by default.
