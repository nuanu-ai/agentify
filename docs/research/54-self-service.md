# Self-service and administrative decisions

2026-10-19. Product direction and implementation inventory.

Agentify has no staffed service that watches purchases, reconciles payments or
contacts merchants about overdue delivery. The operator's explicit approval
is admission of a merchant to sales for real money. Administrative
access is a permission on an account, not a promise of an employee handling
orders. Maintenance tools can exist without being a required step in a sale.

## What belongs where

| Operation | Who acts | What establishes the result | Current implementation |
| --- | --- | --- | --- |
| Admission to real sales | The operator | Explicit approval of an identified merchant | Admin screen linked from `/admin`; the same idempotent grant is available at the terminal, which also withdraws it |
| Registration, keys, seller details, pause and resume | The merchant | Their authenticated account and existing selling checks | Dashboard and relevant SDK operations; keys are issued and revoked in the dashboard only |
| Payout | The merchant or anyone sending the immutable split's payout | The contract's fixed recipients; wallet confirmation authorizes the transaction | Merchant payout screen; no Agentify signer |
| Test purchase | The merchant's buyer or agent | An actual test-channel purchase and delivery | Quickstart step 6 runs an x402 buyer with the merchant's own test wallet and Base Sepolia faucet funds |
| Full offboarding | The merchant | Accepted orders and payment history remain accounted for; deletion is explicit | Pause and key revocation exist; complete offboarding is missing |
| Late delivery | The merchant's integration | The order's delivery rules | SDK and WooCommerce worker; delivery is refused after merchant closure |
| Refund or another agreement | The merchant and buyer | Their policy and agreement; Agentify does not confirm either | Policy, transfers and external fulfillment belong to the merchant; ADR-0028 |
| Close Agentify fulfillment | The merchant | An authenticated, idempotent action, with an optional buyer explanation | SDK `order.close()` and the shared Orders action in the Agentify dashboard; ADR-0028 |
| Silent payment | Automatic reconciliation | Finalized chain evidence bound to the saved authorization and reserved attempt | Configured RPC enables minutely recovery, including closed orders and lost hashes; facilitator-only payments retain unresolved outcomes; ADR-0027 |
| WooCommerce recovery | The merchant, with system checks | The original shop and sale match exactly; an uncertain creation is never repeated blindly | Authenticated page from the merchant's Orders links an existing download order or retries its saved delivery; no shop creation action; ADR-0023 |

## The shop's responsibility

The merchant owns stock, fulfillment, cancellation and refund policy, money
transfers and fulfillment outside Agentify. The connector translates the shop
into Agentify's purchase and delivery contracts. The recovery action attaches
the exact existing shop order to its sale; it does not create a shop order
again or decide what the shop should do. This applies the connector boundary
in ADR-0023 and ADR-0036: WooCommerce-specific rules do not become business
decisions in Agentify's core or SDK.

The product owner's accepted decision is that Agentify does not confirm
refunds or adjudicate the parties' agreement. The merchant closes future
Agentify fulfillment through one authenticated, idempotent action, optionally
explaining it to the buyer. Agentify records "fulfillment closed by merchant";
a statement about a refund or agreement is visibly the merchant's statement.
A missed deadline means unfulfilled by that deadline, not a mandated return of
the whole price. Partial refunds, another currency or network and offsets need
no Agentify exception or database repair. The original payment and history
remain, and Agentify retains its 0.1% commission. This direction is accepted in
ADR-0028.

## Closing fulfillment

The SDK's bound `order.close()` method and the Orders page in the Agentify
dashboard call the same merchant-authenticated action. Its optional `message`
is preserved as written and shown as the merchant's explanation to the buyer.
The API accepts no financial evidence or refund amount. Repetition preserves
the first recorded time and explanation, unless a payment completed after the
closure, when the next closure records its own. A lost response can be checked by
reading the order or retried safely; it does not establish failure.

The action stops future dispatch, redelivery and release of held goods through
Agentify. It refuses an order whose delivery or shipment is already recorded
(`fulfillment_complete`), and an order that ended with nothing charged and
nothing held (`nothing_to_close`), since closing that would only replace the
reason its agent acts on. An ended order whose charge went unanswered, and an
expired one still holding late goods for a repeat purchase, stay closable. It
does not cancel a shop order, a running merchant handler or a charge already
sent to the facilitator. The WooCommerce integration uses the same Agentify
action; it requires no WooCommerce setting and makes no cancellation or refund
call to the shop.

The message is held to the plain-text rule of a card's description, bounded at
2000 characters, and refused with words otherwise, because a stranger's agent
reads it. On a paid closed order the agent also reads Agentify's own reason
sentence, so the merchant's words are never the only voice beside
`payment_status: paid`. When a payment unresolved at closure completes, the
merchant is sent `order.unfulfilled` with the reason `paid_after_closure`,
and the order returns to their open list until they close it again with a new
message.

An overdue paid order reads `unfulfilled`; merchant closure reads
`fulfillment_closed` with an attributed `merchant_closure`. Reads carry original
`payment_status` separately as `not_paid`, `paid` or `unresolved`. An unresolved
payment retains `payment_unresolved` as the main status even after closure.
Late original payment evidence updates these facts without restarting
fulfillment or creating another charge. Accepted payment authorizations remain
reserved, and the existing address-erasure rules continue to apply.

The database migration changes exact stored status, receipt outcome and queued
event fields. It preserves payment records, original closure reasons, goods and
merchant text. Historical terminal rows without an authenticated merchant
closure remain neutral: no merchant actor, explanation or action time is
invented. The gateway issues receipts for recorded delivery or shipment, not
for closure or a claimed refund.

### Closure acceptance evidence

Recorded on 2026-10-19, before the corrections of 2026-10-20; the counts below
are of that day.

The focused core, gateway, contracts and SDK checks cover immutable closure,
concurrent delivery, queued handovers, held goods, pending payments, late
original payment recovery, parcel address erasure and the delivered/shipped
refusal. An independent technical review exercised 270 post-closure state/event
combinations. Its HTTP probe found a private-order disclosure when an unpaid
order closed before or during payment verification; the ownership decision now
requires the recorded payer under the same order lock. Negative HTTP probes
confirm that a public payment reference reveals no private order or merchant
message. The original buyer can still recover a paid closed order through a
fresh verified authorization without another charge. The second review accepted
the fix, with 59 focused tests passing.

Three core/gateway mutations were applied and killed: accepting a dispatch
after closure, releasing held goods after closure, and removing the ownership
guard. Restored controls passed. Twelve independently constructed mode/payment
histories passed outside fixture modules. The contracts' message-bound mutation
was also killed, and packed npm packages passed an authenticated loopback
probe. The complete database suite passed 328 tests on disposable local
Postgres, including state/receipt/event migration and retained original data;
the container and credentials were removed. None of these checks sent money
or contacted a live shop.

The dashboard keeps the existing form controls and typography. Independent
browser review accepted order details at 320, 390 and 1440 px, including keyboard
disclosure, focus and both paid and unresolved closures. An actual keyboard
submission and reload preserved the merchant's literal explanation, left the
original payment unchanged and removed the action after closure. The lost-write
response mutation was killed by an HTTP check and its restored control passed.
All 206 gallery states passed overflow and serious/critical accessibility checks
at 390, 768 and 1440 px. All 41 dashboard browser scenarios passed, including
prefetched navigation and fresh data after a closure. The integrated offline
suite passed 5514 tests in 315 files, plus 14 Node and 14 Python operations
tests; workspace build, typecheck and static checks passed. These checks use
local authenticated routes and memory stores; Safari, screen readers and live
shop operations were not exercised.

## Admission to real sales

The admin screen finds a merchant through the account's normalized email,
shows their name and identifier, and asks for explicit confirmation before
admission to real sales. It requires the account's operator flag on every
request. It grants nothing on a test channel, creates no merchant, and changes
neither orders nor wallet balances. Other publication and purchase guards
remain in force, including the live restriction on WooCommerce and parcels.
A lost write response is shown as unknown; reading the merchant again recovers
the status, and a repeated approval preserves the original approval time.

## WooCommerce recovery

The merchant opens an authenticated recovery page from their own Orders. The
owner is checked before recovery details are disclosed or the shop is called.
For a download whose shop-order creation is uncertain (`create_unknown`), the
merchant supplies the exact existing WooCommerce order ID. The connector uses
the shared sale and product checks before binding that order and attempting
delivery. The page offers no shop creation action. Parcels and refusals before
shop creation are unavailable here; address erasure and live-channel gates
remain in force.

A recorded shop order and delivery (`placed`) can retry the saved delivery
after the shop is disconnected or the merchant switches to their own SDK
integration. An unknown delivery result retains the shop-order binding and
remains unresolved. Confirmed delivery removes the action. These operations
reuse the connector's existing contracts and add no shop-specific core or SDK
states.

## Automatic payment recovery

Real payment admission accepts x402 v2 exact EIP-3009 USDC on Base and Base
Sepolia. It validates the signed terms and saves recovery context without
calling RPC. Unsupported methods are refused before submission. The immutable
attempt and the permanent reservation of the authorization commit before
settlement is submitted, so a restart does not submit again.

With RPC configured, the existing queue checks overdue unanswered attempts
every minute, including orders the merchant closed. Pending and unfamiliar
facilitator failures remain unknown. A settlement can only land while its
authorization is valid, so the search covers about two minutes of blocks: from
thirty seconds before the payment was verified, the allowance for clock
differences, to its `validBefore`. The start is the verification and not the
settlement attempt, because whoever holds a synchronous authorization can
submit it between verification and the charge. Recovery finds the first block
at or after that start by bisecting block timestamps, reads the receipts of
the blocks up to the first one past `validBefore`, and looks there for the exact
adjacent USDC `AuthorizationUsed` and `Transfer` events. It does not depend on
`eth_getLogs`, which the public mainnet endpoint refuses. A transaction hash is
only a lookup hint. Cancellation or a finalized unused expiry establishes
nonpayment; unavailable or conflicting evidence does not.

Old unresolved records are reconstructed from their saved payment and order,
never today's merchant wallet or payment settings, and searched from the
order's creation. Ambiguous ownership, an
unknown payer, unsupported methods or missing terms stay unresolved, and no
unsupported record is silently reclassified as unpaid.

One recovery sweep runs at a time across gateway processes. It checks up to
four payments concurrently and reads persisted attempts in pages of one hundred.
A free slot takes the next payment without waiting for the other checks or the
whole page, so a slow read does not hold every later merchant behind it. If a
page cannot be read, the sweep waits for its started checks before releasing
its lock. Each result still applies under the order's own lock and attempt
identifier; recovery submits no charge.

Four is a fixed internal limit that leaves room for ordinary gateway work;
it is not a merchant setting or a measured provider capacity. Four slow reads
can occupy every slot, and a large sweep can take longer than the minute
between scheduled runs. The pool improves progress through a backlog without
establishing a recovery-time guarantee.

The 2026-10-21 backlog verification passes 69 focused tests, including a held
early payment with recovery continuing beyond the first hundred records. Four
deliberate regressions are killed: serial processing, unlimited concurrency,
releasing the sweep lock before draining checks, and waiting for a whole page.
A separate run without the shared purchase harness or card fixtures uses
PostgreSQL 17.11 and loopback JSON-RPC for twelve orders. It recovers a finalized
transfer, keeps an HTTP 429 outcome unknown, retains all twelve authorization
reservations and starts no second check from another gateway while the sweep
is held. It submits no recovery charge. This is local scheduling and evidence
validation, not a public-provider capacity measurement or a live purchase.

A failed poll is logged with the class of its error, and each run logs how
many payments are unresolved and the age of the oldest, so an operator can see
that recovery is stuck. At start-up the gateway checks that the RPC answers the
channel's chain identifier; on a mismatch or no answer it says so and leaves
recovery off, while facilitator payments continue. Whoever serves that address
is trusted for payment evidence beside the facilitator: ADR-0027 records what
recovery checks and what it cannot.

Completion races the original callback under the same order lock and attempt
identifier. The due payment deadline is applied first. Held synchronous goods
can be released once unless the merchant has closed fulfillment; a prepaid
order past its payment deadline enters `unfulfilled` without a fresh handover.
Receipt and merchant messages commit with the state. A chain-recovered receipt carries the block's execution time and
transaction; it supplies no fabricated facilitator response header.

The proof relies on the canonical Circle USDC event sequence, checked in
[EIP3009](https://github.com/circlefin/stablecoin-evm/blob/master/contracts/v2/EIP3009.sol)
and [FiatTokenV1](https://github.com/circlefin/stablecoin-evm/blob/master/contracts/v1/FiatTokenV1.sol).
The deployed channels default to their free public Base RPC for these background
checks only. `AGENTIFY_PAYMENT_RPC_URL` replaces the address or disables it when
explicitly empty; the standalone gateway and local Compose have no default RPC.
Facilitator verification and settlement make no RPC calls and remain available
without it and during provider outages. This is
the product owner's explicit availability choice on 2026-10-19: an unresolved
facilitator result can remain unknown until RPC is connected or a late answer
arrives. The attempt and authorization remain reserved throughout. No second
settle is sent for recovery. Finalized evidence can arrive later than the
facilitator's ordinary response.

Acceptance checks cover lost hashes, restarts, competing answers, closed
orders, exact proof binding, missing evidence and atomic claim retention. The
read-only network probe was registered to inspect finalized headers and
existing USDC events, recover an observed transfer and reject altered terms
on both networks, without submitting a transaction.

On 2026-10-19 the Base Sepolia probe recovered existing transaction
`0x38eff5219b3604925913bcfd7f13f648f47aa25a2a41ac914c5c1ad9b0dd31bf`
without a hash hint, with its block time, and rejected an altered amount.
A separate unused expired nonce returned proven nonpayment. Base mainnet's
public endpoint returned HTTP 429 for log queries, including one finalized
block with an exact payer and nonce filter, so a real mainnet transfer without
its hash could not be found that way.

A later read-only probe against both public endpoints confirmed the
limits the search now works within: mainnet answers `eth_chainId`, historical
`eth_call`, `eth_getTransactionReceipt` and `eth_getBlockReceipts`, and
refuses `eth_getLogs` with HTTP 429 even for one block; Base Sepolia caps a
log query at 200 blocks with HTTP 413. Public RPC gives no completion-time
guarantee: a rate-limited endpoint can leave a payment unknown for a long
time, and nothing else on Agentify's side resolves it. A replacement provider
is optional and is then trusted as the public one is. This is consistent with
Base's [public RPC guidance](https://www.base.org/blog/base-mainnet-is-open-for-builders).
A real paid purchase remains a separate capped smoke; no payment was sent by
these read-only checks.

## Remaining work

Parcels remain refused on the live channel until the product owner admits
them. Closure is built; the open parcel questions are named in ADR-0033 and
kept in `00-open-questions.md`.

How long a lost payment answer stays unknown has no bound, and the portal
says so to both the owner and the engineer.

Full offboarding also needs a self-service path. Pausing sales and revoking
keys are available; neither cancels accepted orders, resolves the merchant's
obligations or deletes an account. Accepted orders and payment history must
remain accounted for, without requiring a nonexistent support process.

Agentify promises neither manual intervention nor a refund from its own funds.
