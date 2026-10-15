# Agentify adversarial correctness campaign

Date: 2026-10-15. Subject:
`e11fef741e875ef6f9c42465a6b27577dd2921a1`. The experiment is registered in
[plan.md](plan.md), committed as `f1ca8e19`, and its additions live on
`agent/fuzz-campaign`. Product implementation is unchanged.

The bounded campaign confirms four product defects: an accepted card can
produce a payment header ordinary clients cannot read; malformed wallet
acknowledgments become an unsupported success claim; WooCommerce inspection
accepts a document naming a different product; and a transport failure on an
irrelevant WooCommerce setting can block an eligible product. The other
completed checks preserve their stated consumer promises within the selected
cases. Green execution does not mean all promises hold: twelve checks are
expected failures that preserve reproductions of the wallet and WooCommerce
defects.

Six SDK scenarios and one WooCommerce purchase complete their consumer-flow
checks. Separate chain reconciliation verifies five 0.01 test-USDC payments;
both merchant payouts have canonical successful receipts and exact balance
readback. Deployed WooCommerce availability recovery, application restart and
fixture cleanup pass their stated checks. Testing is complete within the
reported coverage and omissions.

## Product and scope

Agentify lets a merchant publish a product description, called a card, through
its SDK or a connected WooCommerce shop. A buyer's agent discovers the card,
obtains a payment challenge and purchases it. The gateway owns the order
lifecycle. The merchant dashboard shows the merchant's cards, settings,
orders and receipts. A merchant sells through one integration at a time.
The WooCommerce connector fills supported downloads and physical parcels on
TEST; it is not offered on the live channel.

The campaign asks whether accepted information remains usable, refused or
unauthorized forms preserve state, uncertain outcomes remain distinguishable
from known failures, and one sale does not cause duplicate payment or goods
effects. It covers ordinary contract, serialization, lifecycle, SDK, dashboard,
provider-response and connector correctness. An early broader API assignment
encounters a service cybersecurity-risk filter; the completed assignment is
narrowed to ordinary offline correctness. These results are not a repository
security audit or evidence of general attack resistance.

Local payment adapters describe payment outcomes without spending. Local
document servers represent a merchant's responses without contacting that
merchant. Those checks cannot prove a real signature, chain settlement,
provider window or shop delivery. Deployed work is restricted to
`https://test.agentify.ad` and the disposable `https://woo.nuanu.ai` lab.
No production or mainnet operation is part of the campaign. Passing this
controlled rehearsal does not establish the integration of a merchant outside
our control or close Stage 4.

## Selection and finite combinatorics

The input space is unbounded. The campaign uses explicit finite classes and
keeps their meanings separate:

* Full finite products cover the registered API response dimensions, form
  contexts and critical three-event permutations.
* Single-field product and settings mutations isolate admission decisions;
  they do not exhaust every combination of invalid shop settings.
* Reachable state traces use reproducible generation and an independent
  payment/goods ledger. The production transition function selects reachable
  candidates, so reachability selection is not an independent correctness
  oracle.
* Browser traces use a fixed twelve-operation skeleton with seed-selected
  accounts, targets, viewport and values. They do not enumerate arbitrary
  user-event sequences.
* Live cases are a small capped acceptance sample. They do not inherit the
  coverage of the larger local matrices.

No pairwise or exhaustive coverage of the whole product is claimed. Logical
cases, generated traces, attempted transitions, HTTP requests and test-runner
cases are different units and are not added as if interchangeable.

| Work package | Registered selection | Completed work |
| --- | --- | --- |
| Input schemas | Eight families × 32 cases | 256 cases: 49 accepted, 207 refused, all matching the declared verdict. |
| Accepted-card round trips | Two documentation variants × 32 spelling/default combinations | 64 cases compare parsing, publication, merchant readback, public projection and discovery. |
| Lists | Two audiences × sizes 1, 10, 100 | Six complete identity/content comparisons. |
| Malformed JSON | Six malformed forms × four POST routes | 24 final refusals; merchant state preserved. |
| Core lifecycle | Four modes × two price-check modes × 64 seeds × 128 steps | 512 traces and 65,536 attempted steps; 13,624 accepted and 51,912 refused; all 16 states observed. |
| Critical schedules | Six triplets × six permutations × three time positions | 108 cases; 72 use an armed deadline boundary, 36 are explicitly time samples without an armed deadline. |
| SDK responses | Six routes × ten complete-response classes × six representatives | 360 executions; 288 original cells and 72 preregistered replacement cells. |
| SDK worker | Finite stop/restart schedules with inapplicable combinations removed | 34 distinct schedules: 24 handler stops, eight answer stops, one parked poll and one restart. |
| Dashboard forms | Eight actions × four contexts × two merchant positions | 64 cells and 80 HTTP POSTs; accepted forms are repeated. |
| Browser navigation | Three base seeds × sixteen derived traces × twelve operations | 48 passing traces, 576 logical operations; 24 desktop and 24 mobile. |
| WooCommerce qualification | Two positive shapes and 46 product/settings mutations | 48 cases; unsupported mutations publish no card. |
| WooCommerce growth | Nine counts × three page behaviors | 27 cells: 21 execute and six are inapplicable. |
| WooCommerce remote failures | Six points × three outcomes × two product classes | 36 cells: 26 execute, six are inapplicable and four remain unimplemented. |
| Exact-order recovery | Twelve field mismatches, plus a registered positive-control extension | Thirteen cases; mismatches remain unbound, the exact control binds and delivers without another create. |
| WooCommerce grant lifecycle | Six lifecycle inputs × four invocation strategies | 24 memory-adapter executions; not 24 independent database interleavings. |
| Targeted WooCommerce consistency | Two discrepancies × two product classes | Four expected failures. |
| Wallet acknowledgment | Ten provider-response cells × request/component surfaces | Twenty cases: twelve promises hold and eight expected failures reproduce one defect. |
| Discovery-header width | Eight accepted parameter counts | Four ordinary-client successes and four overflows; independent SDK replay confirms two failing widths. |

The eight schema families are cards, purchases, worker polls, key issuance,
merchant settings, quote answers, handler answers and order-list queries.
Round-trip combinations select price string or object, result shorthand or
full form, implicit or explicit synchronous fulfillment, and four permitted
spellings of one five-dollar price. The SDK routes are publication, order
read, order list, delivery, refusal and acceptance. Their response classes are
success, route refusal, retryable error envelope, final error envelope,
malformed JSON, wrong document, a success document with HTTP 503, empty body,
complete truncated JSON and HTTP 429 error envelope. Six representatives
exercise ordinary, spaced, Cyrillic, composed/decomposed and long identifiers.

The dashboard actions are selling-state change, seller name, seller site,
payout wallet, key issuance, key disable, WooCommerce import and disconnect.
Each runs for both merchant positions under accepted repeat, absent session,
stale form with the other account's session, and wrong Origin. Both merchants'
persisted snapshots are compared. Key issuance intentionally creates two keys
when repeated; the other accepted repeats preserve the first completed state.

WooCommerce growth counts are 0, 1, 99, 100, 101, 199, 200, 201 and 1,000,
with normal pages, overlapping pages and a later-page failure. Remote fault
points are protected inspection, raw-file protection, shipping rate, creation
before commitment, creation after commitment and validated-result loss before
redelivery. Each applicable point uses timeout, HTTP 429 and malformed-success
classes. The oracle reads persisted cards and order bindings, distinguishes
received create requests from committed remote orders, and refuses a blind
second creation after an unknown result.

There is an arithmetic error in the frozen worker headline: it says “up to
144”, but the listed factors, three message classes × four handler/fault
classes × three stop phases × two suffix choices, multiply to 72. The plan
is retained as registered. The completed report uses the 34 actual distinct
schedules and does not manufacture 110 unique unexecuted cases from that
headline. The plan's appended execution amendment records the correction
without rewriting the original registration. A parked poll has no delivered
message, events have no answer route,
and throwing or invalid handlers produce no answer-phase case.

API seeds `0xA61015A1` and `0xA61015A2` choose the order of explicitly declared
schema cases. Core seeds are
`uint32(0xe11fef74 XOR imul(i + 1, 0x9e3779b9) XOR cell)`, where the cell is
the mode/price-check combination. Browser base seeds `0xC61A0001`,
`0xC61A0002` and `0xC61A0003` derive sixteen seeds each through
`uint32(base XOR imul(trace + 1, 0x9e3779b9))`. Case and seed ledgers are linked
in the evidence index. Generated sampling is not relabelled as enumeration.

The core modes are `sync`, `async`, `confirm` and `ship`. Event selection
evaluates 1,835,008 transition candidates; that work is not added to the
65,536 trace steps. The selected traces emit 367 charge requests, 237 goods
releases, 237 receipts, 155 debt records and 128 address erasures. These are
pure state-machine effects, not executed payments or deliveries. Their
independent ledger and the separate live evidence answer different questions.

## Test-runner results and controls

The final consolidated unit run uses two workers and reports 5,903 tests:
5,887 passing, zero unexpected failures and sixteen skipped. The passing
number includes twelve expected failures: eight wallet cases and four
WooCommerce cases. Therefore 5,875 are ordinary passing cases; twelve
reproductions continue to demonstrate violated consumer promises. A future
fix that makes an expected-failure assertion succeed causes that test to fail
until its annotation is updated.

The new unit files collect 1,089 runner cases: 350 API, 109 core, 394 SDK,
152 WooCommerce, 64 forms and twenty wallet. The generated core traces are
inside one of those cases, while its 108 critical schedules are separate
cases. The 48 new browser traces run in the integration project and are not
part of the 5,903-unit total. The existing dashboard browser suite also passes
all 32 tests. An outside-fixture SDK package-consumer check and the scanner
operational suites pass. These existing checks are regression evidence, not
additional new fuzz cases.

| Verification | Observation |
| --- | --- |
| Consolidated unit run | 5,903 total; 5,875 ordinary passes, twelve expected failures, sixteen skips, zero unexpected failures. |
| Existing dashboard browser suite | 32 passing tests. |
| New browser suite | 48 passing traces, 576 operations, 75,216 ms. |
| Outside-fixture checks | SDK package-consumer check passes. |
| Scanner operational checks | Fourteen Node and fourteen Python checks pass; no new scanner HTTP matrix is claimed. |
| Scanner browser observer | Seven existing local Chromium integration tests pass in a fresh run; 55 route declarations inventoried separately. |
| Type and formatting checks | Added test files pass their package checks; workspace typechecking passes. |

Mutation checks use disposable copies. The API group kills three applied
mutations: a widened description ceiling, an unconstrained order-query word,
and an omitted public description. The wallet group kills a changed rejection
code. The core group's independent ledger kills duplicate goods and receipt
effects from an already-delivered order, even though the order fields still
satisfy the production invariant check. All five mutations apply and are
killed; none is reported as surviving. Unmodified copies pass their controls.
No dedicated WooCommerce mutation check is recorded.

Positive controls establish that the WooCommerce fixtures admit both supported
classes, and that exact-order recovery can bind an unmodified matching order.
Independent direct-source replay observes both positive product controls and
the four inspection discrepancies. An independent reviewer reconciles the
core, SDK, API, header and wallet counts and identifies the live financial
evidence limit described below.

## Confirmed defects

The priorities below describe consumer impact in the tested boundary. They
are not four security vulnerabilities. Four large-header samples, eight
wallet reproductions and four WooCommerce reproductions are grouped into four
underlying defects.

### 1. Accepted cards can exceed an ordinary client's payment-header limit — P2

A card with 256 scalar parameters is accepted from a 7,867-byte publication
document. Its encoded payment challenge contains an 18,896-byte
`PAYMENT-REQUIRED` header. In Node `v26.7.0`, the measured ordinary HTTP
header allowance is 16,384 bytes: `node:http` fails with
`HPE_HEADER_OVERFLOW`, and native `fetch` fails with
`UND_ERR_HEADERS_OVERFLOW`. A buyer cannot read the challenge needed to buy a
card the merchant was told was published.

The sampled widths are 1, 32, 64, 128, 256, 512, 1,024 and 2,048. All remain
under the 256 KiB publication cap. The first failing sampled width is 256;
128 succeeds. This does not identify the exact threshold. A one-megabyte
header allowance receives a valid 402 challenge at every width. Independent
replay publishes widths 256 and 512 through the actual SDK, obtains success,
decodes all parameter declarations with the enlarged reader, and reproduces
both default-client overflows without creating a payment authorization.

Admission is owned by `packages/contracts/src/param-spec.ts` and
`apps/gateway/src/app/gateway.ts`; discovery expansion is in
`packages/contracts/src/card.ts`, and header serialization is in
`apps/gateway/src/http/x402.ts`. The detailed
[header report](header-results.md) provides source lines, reproduction and
primary/independent ledgers. The result concerns these measured clients; it
does not establish every browser or proxy limit.

### 2. Malformed wallet acknowledgments become a sent-payout claim — P2

The real `sendPayout` function returns `sent` after any resolved
`wallet_sendCalls` request. Answers `null`, `undefined`, `{}` and `{ id: 7 }`
all produce that result, and the real `CoinbasePayout` component displays its
sent message. Those responses contain no readable batch acknowledgment.

Twenty cases cover ten response shapes through the request and component.
Twelve promises hold; the eight malformed-answer checks are expected failures
reproducing this one defect. Rejection, provider failure and a lost session
remain distinct in the passing controls. Valid acknowledgments may remain
pending: the existing application contract defines `sent` as wallet
acceptance, not confirmed chain execution, so pending execution alone is not
reported as a defect.

Owning code is `apps/dashboard/app/wallet/requests.ts:135` and
`apps/dashboard/app/wallet/buttons.tsx:193`. The
[wallet report](wallet-results.md) contains the provider-response reference,
minimal reproduction, actual recorded outcomes and independent null-response
replay without `it.fails`. No connected Coinbase service is observed emitting
these malformed values, and no real payout occurs in these local tests.

### 3. WooCommerce inspection accepts a document naming another product — P2

Asking for product `1` and returning an otherwise valid product document with
`id: 2` yields `ok: true` with eligible `productId: "1"`. Both download and
parcel variants reproduce it; changing only the identifier back to `1`
produces the accepted controls. The parser requires a positive response ID
but the inspector never compares it with the requested ID.

An explicitly mismatched response can consequently supply another item's
eligibility, price and download facts under the requested identity. The
campaign does not demonstrate stock WooCommerce returning this mismatch or
an end-to-end wrong-goods delivery. The defect is response consistency at the
existing product boundary. Owning code is `ProductSchema` and
`inspectProductInTheShop` in `apps/dashboard/src/woo-shop.ts`, around lines
118 and 225–234. The [WooCommerce report](woo-results.md) contains both
reproductions and the independent direct-source observations.

### 4. An irrelevant WooCommerce transport failure blocks inspection — P3

Inspection fetches ten product/settings endpoints in one `Promise.all`.
Class-bearing response filtering happens after that promise resolves. A
transport rejection from any endpoint therefore aborts the entire check:
losing only the shipping-destination setting blocks an otherwise valid
download, and losing only the download-login setting blocks an otherwise
valid parcel. Both return `ok: false, again: true`.

The product comment explicitly says only settings bearing on the product
class decide. A merchant can lose supported product availability because an
endpoint their product does not need fails. Paid-order effects for this exact
irrelevant-setting fault are not independently exercised. Owning code is the
class-bearing-settings comment and common batch/catch in
`apps/dashboard/src/woo-shop.ts:136–180`. The
[WooCommerce report](woo-results.md) preserves the minimal inputs and two
expected-failure checks.

## Deployed TEST and recovery evidence

The [operations ledger](operations-evidence.json) verifies TEST running the
exact subject commit, including the application and web image revisions. The
initial TEST revision is `c718f76f97f18d020968d4c4695d969fadcf8621`; it is not
combined with results from the campaign subject.
The application database backup is restored into a temporary database and
56 tables are read back successfully. This is actual database restore
evidence. The WordPress archive is validated as an archive; no WordPress
restore is demonstrated. Neither observation is relabelled as a restore of
every component on the shared host.

The shared host also runs an unrelated service. Campaign authority covers the
TEST app and WooCommerce lab, not host-wide shutdown, firewall changes or
resource exhaustion. One campaign operator owns the deployed environment,
browser and mailbox; the other agents use bounded local fixtures. The final
readback and closeout below
identify the owned resources retained or changed by the campaign.

The final operations readback at 16:47:28 UTC finds all five owned containers
running. The application, PostgreSQL, WordPress and WooCommerce database have
healthy declared checks; the web container has no declared healthcheck.
`/healthz`, `/dashboard/healthz` and `/x402/catalog` each return HTTP 200.
The ledger retains byte counts and SHA-256 hashes for the application dump,
WordPress SQL archive and WordPress file archive. The temporary application
restore is dropped after verification; the live database is not replaced.

The [WooCommerce grant ledger](woo-connect-evidence.json) records a completed
public login/authorization flow and actual callback. This proves the connection
handover. The separate purchase ledger below supplies the fulfillment evidence;
neither establishes failure recovery.

## Completed live SDK consumer flows

The reusable [live script](../../../scripts/fuzz-campaign/live-sdk.ts) pins
TEST, Base Sepolia chain 84532, canonical test USDC, the allowed recipient and
the accepted order quote. Before signing, it durably reserves the authorization
under a process lock. The registered ceilings are forty authorizations,
0.01 test USDC each, 0.40 test USDC total and 0.0005 test ETH gas. An unknown
attempt remains reserved. The HTTP ceiling is 2,000 requests with bounded
concurrency and a sustained rate of at most five requests per second.

The [live SDK ledger](live-sdk-evidence.json) records six completed scenarios:

| Scenario | Observed consumer result |
| --- | --- |
| Unsupported confirmation mode | Publication refused under `card_rejected`, naming fulfillment; no authorization reserved. |
| Synchronous fulfillment | Delivered; one handler invocation; received content matches 1,785 bytes and the expected SHA-256. |
| Asynchronous fulfillment | In progress, then explicitly delivered; repeated delivery returns `already_delivered`. |
| Synchronous refusal | Rejected with `cannot_fulfill`, no goods and no settlement response header. |
| Handler redelivery | First handler failure, second invocation, then delivered content. |
| Late debt closure | In progress, refund due, then delivered; late delivery returns `debt_closed_by_delivery`, and a duplicate returns `already_delivered`. |

The recorded SDK snapshot contains 56 HTTP requests, five reserved signed
authorizations and 0.05 test USDC reserved. Reserved is not spent. Subsequent
WooCommerce work uses the same persistent budget; those values are not the
final campaign totals.

The live script treats the settlement response header as optional. Its status
and handler observations alone therefore do not prove payment or once-only
receipts. The separate read-only reconciliation below closes that evidence
gap for the observed campaign orders and chain intervals.

## Completed live WooCommerce consumer purchase

The [WooCommerce purchase ledger](live-woo-evidence.json) records an actual
purchase of the imported Gift Message Templates download. The accepted quote
and purchased order have the same hashed identity. The application first
returns `in_progress`, then `delivered`; no SDK fulfillment worker runs for
this merchant. The native result contains the expected file name and a
nonempty WooCommerce order number, recorded as lab order `25`.

The script fetches the private download twice and compares both complete
byte buffers with the seed file. The observed length is 1,785 bytes and the
SHA-256 is
`f447b2eb59a3ce1b71c17d09c139fcd90ad0ba34c94de98134fde3b0c0f83387`.
No download capability is retained in public evidence. This establishes the
delivered content for the tested purchase; payment and receipt reconciliation
are a separate observation. The imported card is reused directly, so this
live case does not claim a second successful import or import idempotency.

The shared SDK/WooCommerce budget snapshot after this purchase contains
63 HTTP requests and six reserved authorizations, or 0.06 test USDC reserved.
Reservation includes an unpaid refusal and is not the actual transfer total.

## Chain reconciliation and deployed recovery

The read-only [reconciliation script](../../../scripts/fuzz-campaign/reconcile.ts)
and [ledger](reconciliation-evidence.json), rerun at 16:42:44 UTC after its final
assertions, verify Base Sepolia chain 84532 and the canonical test-USDC token.
Every receipt transaction succeeds and contains exactly one 10,000-unit token
transfer from the campaign buyer to that merchant's campaign-specific split.
With six token decimals, that is 0.01 test USDC. Receipt order identifiers and
transaction hashes are unique, and the receipt transaction set equals the
observed buyer-to-split transfer transaction set. Repeated status reads leave
the receipt lists unchanged, and all receipted orders report delivered.
The split is the on-chain payment-recipient contract configured for the
merchant.

| Merchant | Application observations | Chain interval and transfers | Split balance before payout |
| --- | --- | --- | --- |
| SDK | Five orders: four receipts and one rejected order without a receipt. | Blocks 48,156,606–48,157,139: four transfers of 0.01 test USDC. | 0.04 test USDC. |
| WooCommerce | Three application orders, including two unsigned quote probes; one receipt. | Blocks 48,156,926–48,157,142: one transfer of 0.01 test USDC. | 0.01 test USDC. |

Each queried interval begins 100 blocks before its first successful payment
and ends at the sampled chain head. There is no extra buyer-to-split transfer
in those intervals, including the SDK refusal, redelivery and late-delivery
exercise. This is a bounded no-extra-charge observation, not an assertion
about all chain history. The total observed spend is 0.05 test USDC; the
buyer's balance moves from the recorded initial 2.952 to 2.902 test USDC.
Six authorizations remain reserved in the spending ledger because the unpaid
refusal does not release its reservation.

The [recovery ledger](recovery-evidence.json) records a temporarily invalid
connector secret in TEST. After allowing the worker's polling interval to
elapse, an unsigned probe receives HTTP 409 without a payment challenge.
Restoring the secret yields HTTP 402 with the challenge. No new authorization
is signed. An immediate first probe races a worker already holding the prior
connection; that harness observation is retained and the corrected probe
waits 6.5 seconds.

Source-side WooCommerce readback finds exactly one correlated remote order,
lab order `25`, paid for 0.01 and completed. Restarting only the Agentify
application container preserves the delivered status and returns the same
1,785 download bytes and SHA-256. The post-recovery reconciliation above
still has one WooCommerce receipt and one transfer. This deployed exercise
checks prepayment availability recovery and persistence of an already
delivered order. Loss during an in-flight paid creation is covered only by
the local injected-failure ledger, which refuses a blind second create.

The first reconciliation attempt encounters the public RPC's 200-block query
range limit and HTTP 413. The script is corrected to request 199-block chunks;
that harness constraint is not a product defect.

## Verified merchant payouts and final spending

The [payout script](../../../scripts/fuzz-campaign/payout.ts) uses the controlled
merchant signer and the application's actual payout transaction builder.
The [payout ledger](payout-evidence.json) records both reservations as
`verified`: their receipts succeed, have nonzero block hashes matching the
canonical blocks, and are observed after a further block. Exact token
transfers, wallet balances and warehouse credits match the independent ledger
prediction. There is no other tracked transfer or warehouse activity in
either attribution window. The two campaign merchants use the same controlled
recipient wallet; this does not test two different payout recipients.

The warehouse is the payout contract's balance-and-credit store. A credit
there is an allocated amount that has not yet become a token transfer to its
owner. The table accounts for all 50,000 token units received by the two
splits. One unit is 0.000001 test USDC; credits are not counted again as
wallet balances.

| Allocation or retained amount, in token units | SDK payout | WooCommerce payout | Total |
| --- | ---: | ---: | ---: |
| Transferred to the merchant wallet | 39,958 | 9,989 | 49,947 |
| Added commission credit | 39 | 9 | 48 |
| Tokens retained at the split | 1 | 1 | 2 |
| Credit retained for the split | 1 | 1 | 2 |
| Added residual merchant credit | 1 | 0 | 1 |
| Total | 40,000 | 10,000 | 50,000 |

The merchant wallet receives 0.049947 test USDC. Commission remains a
0.000048 test-USDC credit; this campaign does not withdraw that credit.
The payout transactions consume 2,038,248,000,328 and 1,713,720,000,328 wei,
including recorded L1 fees, totaling 3,751,968,000,656 wei
(0.000003751968000656 test ETH). The merchant signer starts with 0.0001 test
ETH and ends with 0.000096248031999344. This is below the 0.0005 test-ETH
gas ceiling. Six signed authorizations reserve 0.06 test USDC, while five
settlements actually transfer 0.05; an unpaid refusal retains its reservation.

The first receipt reads contain zero block hashes and are retained as initial
observations. The read-only verification waits for canonical receipts of the
existing transactions; it sends no replacement payout. The successful result
does not resolve the separate malformed wallet-acknowledgment defect: the
live payout uses a controlled signer, while the Coinbase component/provider
matrix remains local evidence.

## Deployed readback and fixture closeout

The [closeout ledger](closeout-evidence.json) records 22 bounded application
calls across the two campaign merchants. For each merchant, anonymous and
invalid-key reads return 401, the other merchant's pause request returns 404,
and malformed publication JSON returns 400. The catalog remains identical
after those refused requests. Selling pause succeeds, its repetition is
idempotent, and persisted readback agrees. These are the observed account-
context checks; no general security-audit conclusion follows.

The public API intentionally refuses disabling its own calling key with 409;
the key remains usable at that point. Cleanup then disables each fixture key
through the owner's store method, and two further revoked-key reads return
401. The final readback finds no campaign cards in the public catalog, with
thirteen other cards remaining. The lab download product's original price,
0.05, is restored, and temporary administrator-credential copies are deleted.

The two TEST merchant records, paused cards, completed orders and receipts,
WooCommerce connection, and the campaign merchant key in an ignored mode-600
file are deliberately retained for owner inspection. The browser retains the
WooCommerce campaign account session. These retained fixtures are documented
state, not a claim that the database has been reset to its initial contents.
No product fix is deployed.

The final interactive browser reload is not executed because the operator's
Mac is locked. API and container readbacks above supply the completed closeout
observations; the unavailable browser action is not a product failure.

## Scanner second-wave boundary

The [scanner inventory](scanner-results.md) maps all 55 declarations in
`apps/web/app/routes.ts`: 27 API templates, 27 other concrete templates and
the wildcard 404. A parameterized template counts once. Generated framework
data requests and assets do not add route declarations. The mapping names
the existing assertions and separates refusal checks made before persistence
from database-backed successful operations.

A fresh run of the existing browser-observer integration file passes all seven
tests in 8.28 seconds; the [runner output](scanner-integration.txt) retains
the command and result. Real Chromium uses local HTML fixtures and an injected
resource reader. The checks cover aggregate extraction, runtime guards,
popup refusal, main-document attribution, unfinished-resource cancellation,
recovery after a nonyielding script and truthful load-timeout classification.
No external target is scanned. Fifty-five inventoried declarations are not
fifty-five tested HTTP flows, and the seven tests are not new fuzz cases.

## Explicit omissions and harness corrections

The sixteen skipped WooCommerce cells are six unreachable second-page
alterations at catalog sizes 0, 1 and 99; six class-inapplicable raw-download or
shipping failures; and four unimplemented malformed/429 gateway-answer cells.
Only the local validated-result-loss seam is exercised for that last group.
Shipping failures use a cart-result seam, not the complete real WooCommerce
cart HTTP sequence. Grant schedules use the memory adapter, not Postgres.

Seventy-two originally planned SDK connection-loss cells, before headers or
during a body, remain unexecuted. Before the narrowed response run, 72
replacement cases are registered for complete truncated-JSON documents and
429 envelopes. Their passing results do not prove a broken-exchange
`outcome_unknown` classification. A handler that never resolves is not tested
as bounded stop, because the documented stop waits for its handler.

Local list checks stop at 100 accepted cards, and the API input cap is 256 KiB.
They do not discover a complete operational response bound. The header
experiment measures sampled widths in Node `v26.7.0`, not the exact threshold
or other clients. Browser prefetch intent is exercised, but the new traces do
not count prefetch requests or cache hits. Cookie replacement models a
completed other-tab login; the local traces do not invoke a real identity
provider. New scanner HTTP combinations and database adapter differential
testing are not completed by this campaign.

The registered eight-trace deployed-browser subset has no complete separate
ledger here. Real email-login setup and the WooCommerce grant are observed;
the 48 new traces and 32 existing browser passes use the local Chromium
harness. Remaining deployed browser combinations are not counted as passes.
The separate closeout ledger supplies the selected deployed anonymous,
invalid-key, revoked-key and other-account observations; local form results
are not substituted for those observations.

Scanner omissions include database-backed accepted scans, reports, shares,
registration, consent, card signals and deletion; complete worker-to-report
delivery; public-share HTML and operator HTTP success; compiled web startup;
and live Stripe, Turnstile, analytics and scanner identity flows. No generated
scanner HTTP body/error/scale matrix is completed. The inventory's references
to existing P4/P5 integration cases are source mappings, not fresh executions.

Initial harness failures remain separate from findings. Restricted HTTP
listeners encounter `EPERM` and are rerun in a listener-capable process.
A WooCommerce fixture accidentally matches a product-settings path as a
product response; another assertion reads the wrong card-wrapper level. A
form fixture looks up a normalized email with an uppercase label. Those
errors are corrected before the completed controls and reruns. Scratch
mutation imports and a scratch jsdom path also require harness corrections.
The first header probe uses the wrong path, and a direct runner cannot import
the Vitest-dependent gateway fixture; neither attempt supplies product
evidence. No such failure is included among the four confirmed defects.

## Evidence index and completion boundary

| Evidence | What it retains |
| --- | --- |
| [API report](api-results.md), [API ledger](api-evidence.json) | 256 schema and 94 HTTP cases; inputs, expected/actual classifications, controls and mutations. |
| [Core/SDK report](sdk-state-results.md), [core/SDK ledger](sdk-state-evidence.json) | State/event/effect counts, seeds, critical schedules, 360 response cases and 34 worker schedules. |
| [WooCommerce/form report](woo-results.md), [case ledger](cabinet-woo-evidence.json) | 152 connector registrations, sixteen skips, four expected failures, 64 form cells and source hashes. |
| [Navigation report](navigation-results.md), [seed ledger](navigation-evidence.json) | 48 derived seeds, twelve-operation skeleton, viewport and account/target selections. |
| [Header report](header-results.md), [primary ledger](header-evidence.json), [independent ledger](header-independent-evidence.json) | Eight widths and actual default/enlarged client outcomes; two independent SDK replays. |
| [Wallet report](wallet-results.md), [wallet ledger](wallet-evidence.json) | Twenty real-request/component observations, eight expected failures and controls. |
| [SDK live ledger](live-sdk-evidence.json) | Six TEST consumer scenarios, statuses, content hashes and reserved-budget snapshot. |
| [WooCommerce connection ledger](woo-connect-evidence.json) | Public login/authorization statuses and completed grant handover. |
| [WooCommerce purchase ledger](live-woo-evidence.json) | Imported download purchase, status progression, lab order number and two complete byte comparisons. |
| [Chain reconciliation ledger](reconciliation-evidence.json) | Five receipt-to-transfer matches, explicit block intervals, receipt stability and pre-payout balances. |
| [Recovery ledger](recovery-evidence.json) | Invalid/restored connector availability, one source-side WooCommerce order and delivered content after application restart. |
| [Payout ledger](payout-evidence.json) | Two canonical successful transactions, exact transfers/credits/balances and actual gas costs. |
| [Closeout ledger](closeout-evidence.json) | Selected deployed account-context checks, repeated pause, revoked-key readback and retained/restored fixture state. |
| [Operations ledger](operations-evidence.json) | Exact deployed revisions, backup hashes, actual 56-table temporary restore, owned-container health and three successful public routes. |
| [Scanner inventory](scanner-results.md), [fresh observer run](scanner-integration.txt) | 55 route declarations mapped to existing evidence and seven freshly passing local Chromium tests. |

Public artifacts contain no real API keys, session cookies, sign-in links,
payment signatures or private download capabilities. Private recovery inputs
remain with their operator. The campaign leaves reusable tests and
reproductions; it includes no product fixes. The result remains bounded
evidence rather than a claim that every possible input has been tested.
