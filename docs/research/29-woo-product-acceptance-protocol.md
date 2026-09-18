# Agentify experimental WooCommerce TEST acceptance protocol

**Pre-registered:** 2026-09-18. Execute under COIN-25 from the deployed
COIN-41 SDK baseline, after the Woo implementation is reviewed and deployed.
WooCommerce remains experimental. This run does not gate or close Stage 4.

## Product claim and narrow boundary

From the public Agentify entry, a new owner can open a TEST cabinet, connect a
stock WooCommerce shop over real TLS, import only a product the connector can
actually fulfil, and complete a capped TEST purchase whose agent retrieves the
exact promised bytes from a native Woo download permission returned by
Agentify.

The five reset-baseline products do not meet that claim. They are simple,
virtual, non-downloadable gift cards with no files, unmanaged stock and no
voucher plugin. An order number is not the brunch, workshop, dinner, escape or
wellness value they promise. They are negative evidence and must never be the
paid happy path.

The first supported class is deliberately narrow:

- one published, purchasable, in-stock, unmanaged-stock, not-sold-individually
  Woo `simple` product;
- `virtual=true`, `downloadable=true`, USD, exactly one enabled native file;
- Woo tax calculation disabled; the product's dormant tax-status default does
  not matter while the shop cannot calculate tax;
- unlimited download count and expiry;
- Force Downloads, insecure redirect fallback off, download login off, and
  access after payment on;
- a same-origin protected Woo upload, created in the product editor, whose raw
  URL is not publicly retrievable.

The product's card is asynchronous and price-checked at purchase. Its required
result is `download_url`, `file_name` and `order_number`. The URL is the
native Woo permission for this order, never the product's raw file URL. It
contains the order key, product/download identifiers and Woo's `uid` hash of
the merchant order email. No buyer email is requested. ADR-0023's merchant
email stays on the Woo order.

This URL is a bearer secret, not wallet-bound. A clean unauthenticated client
that possesses the exact URL can fetch the file. The order key and `uid` are
therefore buyer data: the URL appears only in that order's delivery, never in a
card, catalogue, cabinet list, ordinary log, screenshot, tracker comment or
report. The API keys, merchant email and raw file URL never appear in it.

## Implementation invariants before any paid Woo run

These rules are checked in isolation before the live cases:

1. Import combines the public Store catalogue with an authenticated product and
   settings read. Unsupported products, including all five baseline gift cards,
   are skipped with no order-number-only card.
2. Every imported identity binds normalized shop origin as well as Woo product
   id, so reconnecting to shop B cannot fulfil shop A's product 42.
3. Woo order creation is not a two-outcome call. A timeout, lost response,
   5xx/408/429, malformed successful body, missing Woo id, or a local ledger
   failure after a valid create can all mean Woo committed while Cabinet did not
   learn enough. Every ambiguous outcome retains the claim and never causes a
   blind retry.
4. The Woo ledger keeps only Woo id/number. It cannot reproduce the permission
   result after a restart. Once Woo answers successfully, Cabinet must durably
   record bound shop origin and exact permission ingredients with Woo id/number
   before acknowledging or delivering the Agentify order. The full URL need not
   be stored; the reconstructed result must be byte-identical.
5. A successful asynchronous Woo hand-over returns `{delivered: result}` on the
   existing `answer_order` route. Once the exact result is durable, existing
   at-least-once redelivery repairs a crash or lost answer. A definite refusal
   makes the order `refund_due`; the gateway may hand it over again so late goods
   can still close the debt. A worker seeing `precreate_refused` repeats the safe
   refusal and makes no Woo POST. Only the explicit operator command may reopen
   creation after a same-origin reconnect under a new revision. Core already
   permits direct late `deliver_order` to close that debt, but Cabinet has no
   bounded operator path to validate/bind the Woo order and call it. That private
   recovery command is a blocker; no public route or SDK change is owed.

There is no documented exact Woo order query by Agentify transaction id or
metadata. The collection API offers only generic search. Initial code therefore
does not pretend an ambiguous remote create can be reconciled automatically. It
leaves one durable unknown claim, creates no second Woo order, and closes the
initial hand-over as `refund_due`. Recovery never infers absence: the operator
must find the exact Woo id in Woo admin and supply it. Cabinet validates that
one order by authenticated id readback and, only when every origin, identity,
product, amount, paid-state and permission fact matches, binds the saved result
and calls the existing idempotent late-delivery route. A known pre-create
refusal may issue one fresh POST only after the same shop reconnects under a new
private revision and fresh authoritative preflight.

The three ledger phases name those facts. `precreate_refused` means an
authenticated preflight failed before any order POST. `create_unknown` means
the POST may have committed but no validated result is durable. `placed`
means the exact Woo order and permission result are durable. The only allowed
transitions are absent to either refusal or unknown, refusal to unknown through
explicit recovery, and unknown to placed through exact validated binding.
Unknown and placed never move backwards. Every phase keeps the order's accepted
`price_id` and quote fingerprint; current drift is never saved as sold goods.

## Safety and evidence

- TEST only; zero real-money spend. Each signed attempt is at most `0.01` Base
  Sepolia test USDC. The dedicated durable ledger reserves exactly three
  attempts and `0.03` total; a crash consumes its reservation. Never run the
  repository's unbounded root `pnpm buy` command or allow mainnet.
- The live paid matrix has exactly three planned authorizations: ordinary happy
  delivery, revoked-key pre-create refusal and recovery, and committed-create
  empty successful response followed by exact-id recovery. The one-shot MU hook
  suppresses the committed response body; it does not simulate a TCP or header
  loss. Recovery reuses the paid Agentify order and signs no second payment.
- Operations alone resets `woo.nuanu.ai` on `codex-vm` with
  `cd /home/dmitry/woocommerce-lab && ./reset-store.sh`, then `./verify.sh`.
  Never use `--rebuild-baseline` or copy reset stdout, which prints credentials.
  Verify the public edge off-host.
- Use a new email alias and distinct TEST buyer/payee wallets. Change only the
  dedicated native-download product to `0.01 USD`; never buy a baseline gift
  card at its catalogue price.
- Before attempt 1, freeze one secret-safe ledger row that binds Woo product 22,
  its imported Agentify item id, buyer/payee public addresses and the expected
  148-byte SHA-256
  `92a457abce8665901afcf82e30afe432cf4f19f78035f3e3d763ddbd39f0c7c2`.
  The account is a separate Agentify merchant; the existing Woo shop and admin
  are reused after the authorized reset.
- Record candidate SHA, UTC time, actor and evidence level: **Browser**, **Woo
  owner UI**, **Woo readback**, **Operator buyer**, **TEST chain**, **Cabinet**,
  or **Isolated failure**. Unit evidence is not deployed evidence.
- Store no email links, keys, cookies, payment payloads or full permission URLs
  in notes. Stable public ids and expected/received artifact SHA-256 are allowed.
- For each browser row ask whether a cold owner can infer the next action,
  repair an error without retyping known data, distinguish TEST from real,
  return safely with Back/reload, and see only supported promises.

## Finite acceptance matrix

`CB` is a current blocker to remove, `IT` an isolated implementation test,
and `LA` a deployed live acceptance step.

| # | Level | Case | Expected observable outcome |
|---|---|---|---|
| 1 | LA | Reset and read baseline | Exactly five named gift cards, no Woo orders or Agentify REST keys, valid public TLS; Agentify TEST unchanged. |
| 2 | LA | Cold `/` arrival, fresh email cabinet, name/wallet, reload, second tab and reauth | Merchant/Woo route is discoverable; one merchant persists; SDK is primary and Woo remains experimental. |
| 3 | IT/LA | Blank, malformed, plain HTTP, query-bearing, non-root-path and nonexistent public Connect inputs; private or mixed public/private DNS only in isolated refusal tests | Refusal occurs before navigation, preserves repairable input and never claims a connection. Every Connect preflight, authenticated REST call, exact-id recovery GET and raw-file check resolves only public addresses, pins the approved address for the connection, preserves TLS host verification and refuses redirects before credentials or protected destinations can be followed. Do not probe a private address live. |
| 4 | LA | Plain permalinks, abandoned/declined grant, Back/reload, expired cabinet session mid-grant | Permalink repair is named; abandoned grant leaves no key; callback remains account/shop-bound and reauth returns to the same merchant. |
| 5 | IT/LA | Callback missing, expired, replayed or return URL opened by hand | No false connected state or leaked key/token; only the callback row proves success. |
| 6 | CB/IT | Import the five baseline products | All five are skipped as non-downloadable goods; no order-number-only card is published. |
| 7 | CB/IT | Authoritative gates: physical/variable/non-USD/out-of-stock/managed-stock/sold-individually, 0 or >1 file, finite limit/expiry, public/cross-origin raw file, shop tax calculation enabled or unreadable, or login/redirect/fallback/access setting mismatch | Each unsupported fact is named and skipped before payment. A dormant product tax-status value is ignored only while shop tax calculation is disabled. Missing/unreadable facts fail closed; no raw URL or buyer-email parameter is published. |
| 8 | IT/LA | Create owned one-file fixture, import, reimport unchanged, pause, reimport again | One stable origin-bound card is async with price check and three result fields; no duplicate; import never resumes a paused card. |
| 9 | CB/IT | Import product 42 from shop A; reconnect same account to shop B with product 42; quote/buy A card | Origin mismatch is unavailable/refused; no request reaches B for A's card. |
| 10 | IT | Change price/currency, stock, virtual/downloadable, file id/count/source, limit/expiry or global settings after import but before quote | Fresh authenticated quote returns current valid USD price or unavailable. Unsupported/stale state is refused before payment and Woo order. |
| 11 | IT | Change product/source/download id or name, price/currency, or any supported setting after a successful quote but before paid order reaches Cabinet | The order's `price_id` resolves to the persisted non-secret quote fingerprint and the fresh fingerprint must match. No stale permission is invented; mismatch becomes visible `refund_due` with no Woo POST or delivery. Replacing bytes at the unchanged protected URL cannot be detected from Woo metadata and remains an explicit limit. |
| 12 | IT | Payment verification/settlement fails or is unknowable before async hand-over | No Woo envelope, order, permission or delivery is created. Unknown payment is never retried. |
| 13 | IT/LA | Ordinary capped purchase with worker active | Chain settlement precedes Woo POST. One paid Woo order has `set_paid`, exact `0.01 USD` order/line total, zero tax, Agentify order id in transaction/meta, and merchant billing email only. One permission is granted. Any post-create total/currency/line/tax mismatch remains unresolved and is never delivered. |
| 14 | IT/LA | Fetch result with redirects disabled, then ordinarily; repeat after worker restart | Permission returns 200. Agentify `file_name` is the Woo display name `Agentify TEST acceptance artifact`; Content-Disposition names `agentify-test-download-dn3er7.txt`; bytes are 148 bytes with the frozen SHA-256. Agentify is delivered with one receipt; result/bytes survive restart; no second Woo order. |
| 15 | IT | Same order is redelivered before and after durable local result; `answer_order` response is lost once | At most one Woo POST/order/permission and one Agentify delivery/charge; redelivery returns the exact stored result through the existing answer route. |
| 16 | CB/IT/LA | A temporary TEST-only WordPress MU hook uses `rest_pre_serve_request` after Woo has committed one exactly matched order. One atomically consumed option matches the dedicated merchant alias, product 22, `0.01 USD`, Agentify payment method and transaction/meta id; the hook suppresses only that successful REST body, then the hook and option are removed and their absence verified. Woo readback proves one remote order while Cabinet records `create_unknown`. Isolated committed-remote fakes separately cover 5xx/408/429 and malformed 2xx/no id. No fault flag appears in product code or a public route. | Claim stays `create_unknown`, redelivery makes no second POST, and buyer sees refund debt rather than invented goods. Recovery requires an operator-supplied exact Woo id; zero/ambiguous/mismatched readback never reopens POST. |
| 17 | CB/IT | Valid Woo create response, then local durable record fails | Redelivery makes no second Woo POST. Unresolved claim/refund debt survive restart; no permission result is guessed. |
| 18 | CB/IT | Crash after durable Woo/result record but before `answer_order`, then lose one `answer_order` response | Existing stream redelivery reads the placed ledger result and answers byte-identically without another Woo POST. No open-order scanner or accept/deliver split is introduced. |
| 19 | CB/IT/LA | First prove revocation before quote is unavailable with zero payment. For the separately capped recovery case, obtain the valid quote, revoke the key before the settled order reaches Cabinet, then sign once. | The pre-quote case refuses before payment. In the post-quote case payment settles, authenticated preflight records `precreate_refused`, Woo creates nothing, buyer/Cabinet show `refund_due`, event/warning is visible, and no receipt/goods are claimed. |
| 20 | CB/IT/LA | Recover row 19 after same-origin reconnect; separately recover live row 16 with operator-supplied exact Woo id | Known pre-create path requires a newer connection revision, exact accepted product/price and atomically claims one POST before sending it. If that one POST becomes ambiguous, phase becomes `create_unknown`, it is never posted again and only exact-id recovery may continue. Wrong/same revision, changed origin or newly unsupported product keeps debt and makes zero POST. Unknown path performs GET-by-id only and binds only an exact correlation. Both successful paths deliver the same Agentify order, return actual bytes, close debt, issue one receipt, and cause no second authorization, charge or order. Rerun is idempotent. |
| 21 | IT/LA | Permission from clean unauthenticated client; missing/tampered order key, product id, download id and `uid`; another clean client uses intact URL | Intact bearer URL works for either possessor; every mutation fails. It contains no raw email/API key/raw file URL. Boundary is stated, not called wallet-bound. |
| 22 | IT/LA | Request product raw file URL and inspect catalogue, Cabinet pages, logs and tracker-safe output | Actual Caddy-served raw URL is denied even if Woo settings say Force Downloads. If public, product is unsupported until merchant server protection is fixed. Full permission/order key/uid appears only in authorized order delivery/status. |
| 23 | IT | Woo readback has wrong transaction/meta, product, total, currency, billing email, paid status or permission marker | Cabinet refuses to construct/deliver permission and leaves honest refund debt; it never substitutes current product data for sold order. |
| 24 | LA | Pause the acceptance card if required; remove the one-shot MU hook, its option and private acceptance artifacts; revoke or disconnect only credentials proven to belong to the dedicated acceptance merchant, if chosen | Preserve the shared Woo shop, its admin, order evidence and all user activity. The initial authorized reset is the only reset: no second reset is required or performed. |

## Small implementation order and ownership

One COIN-25 writer owns the Cabinet delta so money/order invariants do not split
across concurrent branches:

1. Update ADR-0023 and this protocol with the native-permission class, bearer
   boundary, async refund behavior and origin binding. Public copy promises only
   this class, never general Woo sales or gift-card fulfillment.
2. Add red tests and an authenticated product/settings reader. Bind
   `merchant_item_id` to a stable normalized-shop fingerprint plus product id,
   publish async cards with the existing handler price check, and answer quote
   envelopes from a fresh authoritative read. For the same-origin raw file URL,
   make one no-redirect public GET that stops at the response headers: any 2xx
   or redirect means the asset is public and the product is unavailable; an
   unknown/network answer also fails closed. This never follows or probes a
   cross-origin file URL. Add no SDK field or namespace.
3. Classify outcomes as created, proved-before-POST refusal, or unknown. Lost
   responses, retry statuses, every unvalidated HTTP response, malformed
   2xx/no-id and post-create local failures are unknown and never release
   claims. Every ambiguous test injects a committed remote order.
4. Extend the private Woo order ledger only enough to retain phase, normalized
   root shop origin, connection revision, immutable sold product/amount/currency,
   Woo id/number and exact permission ingredients (order key, download id/name,
   `uid`) before Agentify is answered. Never store/log raw file URL. A `placed`
   claim reconstructs one byte-identical result.
5. Add Cabinet-internal wrappers only for existing quote, get-order and
   deliver-order routes, plus private `woo:recover` with required `--order`
   and optional `--woo-order`. Persist connection revision and ledger phase
   `precreate_refused|create_unknown|placed`. The pre-create path requires the
   same origin, a newer reconnect revision, fresh supported-product preflight
   and an atomic claim before exactly one POST. The unknown path makes only
   authenticated GET-by-id, validates exact transaction/meta, origin, merchant,
   product, quantity, amount/currency, paid state, order key and permission, then
   atomically binds the result. Both call idempotent late delivery and require
   delivered readback. Output contains safe ids/state only; no email, URL, uid,
   key or Woo body. No scanner, absence inference, loop or raw DB edit.
6. Run the finite isolated matrix, mutation self-check, negative control,
   outside-fixtures run, canonical checks and separate-agent review. Deploy one
   immutable SHA, reset fixture, create owned download product, and run live rows.

Operations owns fixture reset, TEST deployment, chain/database evidence and
secret-safe tracker output. A separate engineer owns adversarial review and
makes no branch writes during review. The product owner owns the cold browser,
capped buyer and final verdict. Nobody else mutates the COIN-25 worktree while
its writer is active.

## Verdict and explicit limits

`Pass` requires one final deployed SHA to complete cold Connect/import and all
three capped paid cases: ordinary byte delivery, revoked-key recovery and
committed-empty-success exact-id recovery. Restart redelivery, zero duplicate
charges/orders, actual bytes, bearer-secret checks and cleanup must agree.
`Partial` means happy delivery works but a named failure has no proven
money/goods resolution. `Fail` means goods, orders, money, identity or
secrets are duplicated, lost, misattributed or overstated. `Blocked` names an
external prerequisite and blocks only dependent rows.

Managed stock, physical goods, variables, gift/voucher semantics, multiple
files, finite permission limits/expiry, arbitrary external file stores and
automatic catalogue removal are unsupported initially. COIN-23 still owns
ongoing catalogue synchronization. A change between quote and fulfillment can
create honest refund debt; it is tested and not described as pre-payment refusal.
Woo installations below a URL subpath are refused at Connect; every accepted
shop is bound to the root of one public HTTPS origin.
An unknown create with no exact Woo id remains debt because the command never
guesses that no remote order exists; that is a named support prerequisite, not
permission to POST again.

COIN-22 remains open but does not block this agent-first result. No buyer email
is requested. COIN-34/35 cover Import visibility and its 200-product boundary;
COIN-36–40 retain their Connect/import failure scopes. COIN-25 records this run.

## Prospective amendment after an unsigned runner failure

The first case-2 orchestration prepared unsigned order
`ord_fcc7e8f05232450fa3923b684b997339` and then stopped on a shell
readonly-variable error before credential revocation, wallet-key access,
signature or payment. The quote expired and the gateway closed the order on its
time limit. Readback proved no payment claim, receipt or Cabinet Woo order; Woo
remained at its one happy-case order and permission; balances, connection
revision and current key were unchanged. The failed preparation stays in the
execution record and is not called a product case.

The product owner may authorize one replacement preparation for the same
case-2 scenario after the corrected whole runner and append-only transition
pass offline and independent review. First the ledger verifies the exact public
order is terminal expired in TEST, quoted at `0.01`, and has no delivery, then
appends terminal `aborted_unsigned` evidence to the unchanged attempt-2 row.
That row must have no execution reservation, payment nonce, signature, claim,
spend or merchant-key mutation.

The one replacement is a new `revoked-precreate` row carrying
`replacement_for_attempt: 2`, a fresh private reservation, Agentify order and
challenge. The original `ambiguous-create` case follows it. The ledger may
therefore contain four preparation rows, while execution reservations,
signatures and signed authorizations remain capped at exactly three, `0.01`
each and `0.03` total. Every reservation, order and payment nonce remains
globally unique. The expired order and challenge can never be executed. No
generic reset, loop or automatic regeneration is introduced. Execution still
requires an explicit GO against the immutable reviewed runner.

## Sources

- Product boundary: `AGENTS.md`; `docs/decisions/0023-*.md`;
  `docs/research/27-woo-connect-probe.md`.
- Current connector: `apps/cabinet/src/woo-catalog.ts`, `woo-shop.ts`,
  `woo-shops.ts`, `woo-worker.ts`, `gateway.ts`, `schema.ts` and tests.
- Async contract: `packages/contracts/src/api.ts`, `order.ts`, `card.ts`;
  `apps/docs/orders.md`.
- [Official Woo order API](https://developer.woocommerce.com/docs/apis/rest-api/v3/orders/).
- [Woo native permission binding](https://woocommerce.github.io/code-reference/files/woocommerce-includes-wc-order-functions.html).
- [Woo download handler and uid checks](https://woocommerce.github.io/code-reference/files/woocommerce-includes-class-wc-download-handler.html).
- [Woo digital download guide](https://woocommerce.com/document/digital-downloadable-product-handling/).

`spikes/woo/DEMO.md` is historical local-probe evidence. Its password,
invitation, localhost certificates, sandbox settlement and “nothing else is
needed” steps are not this deployed owner journey.
