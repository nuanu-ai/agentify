# Review of the product acceptance plan

Date: 2026-10-18. Source review against main at
65517099. This note explains the changes to
[the acceptance protocol](42-manual-test-plan.md). It reports no product run,
payment, deployment change or newly reproduced product defect.

## What the review protects

The product owner asked for realistic attempts to break the application,
including situations a merchant or buyer does not anticipate. They also
required independent assessment of what a human understands from the screen,
what an autonomous buyer can discover and safely do, and whether a stranger's
engineer succeeds through the SDK without internal knowledge. The external
catalogue promise is part of that product outcome.

The protocol therefore separates business correctness, UX, AX and DX, and
gives external discovery its own verdict. It measures first interpretations
before coaching. A rendered screen must be observed to judge its clarity;
source text alone cannot establish hierarchy or salience. A public status,
a merchant effect, a receipt and a transfer are separate evidence.

## Checks removed or consolidated

| Prior check | Reason and replacement |
| --- | --- |
| Exact installed dependency tree (A-06) | A deterministic package check does not measure integration. A-03 now requires the published package to run outside the checkout and the engineer to recover from an ordinary mistake. |
| Manual catalogue of every markup, length, tag and client typo (D-02–04, D-08, D-14, D-16) | Keep exhaustive permutations in deterministic tests; use an actual product's edit, intelligible refusal, correction and purchase in D-01. Size and server/publication boundaries remain in D-02/D-03. |
| Any validation-library sentence is a defect | Its origin is not a consumer property. Test whether the engineer understands the cause and safe correction. |
| Oldest-ever npm SDK compatibility (D-21) | There is no such supported-version promise at this stage. Test the currently offered npm package against the actual deployment and report mismatches. |
| Capitalisation of an error, exact headers/buttons and fixed check counts | These can stay correct while the user makes the wrong decision. U tests visible meaning, consequences, accessibility and recovery. I tests useful and honest scan evidence. |
| “Record what happened” as a passing result | Recording an unsafe outcome is not acceptance. Every variant needs an oracle; absent evidence is partial, blocked or not run. |
| “Automated tests cover every promise” and reading labels of unreachable states | Neither establishes end-to-end behavior. Fault requirements are explicit; simulated and actual-provider evidence remain separate. |
| A coached inspector pretending to be a newcomer, or prepared buyer scripts as independent AX proof | Use task briefs with fresh participants; assistance remains evidence. Protocol checks still have value but answer a different question. |
| Exact event or arrival count as proof of one sale | Order redelivery is permitted and events can be lost. J checks durable effects and recovery from open orders. |

## Incorrect expectations corrected

The following are plan defects established from the current sources, not new
claims that the running product fails:

- Buyers pay recorded splits; they do not transfer directly to the merchant
  wallet. Receipts now contain the payment transaction. A payout can aggregate
  several sales, and rounding/dust prevents exact per-sale percentage arithmetic.
  See the [money page](../../apps/docs/money.md) and
  [payout builder](../../apps/gateway/src/split/payout.ts).
- A default asynchronous deadline is exposed, and exhausting five automatic
  handovers does not bring its deadline forward. See the
  [card reference](../../apps/docs/cards.md) and
  [order machine](../../packages/core/src/orders/machine.ts).
- JavaScript acceptance with an extra argument warns but accepts without that
  argument; TypeScript and raw HTTP have different refusal behavior. See the
  [SDK client](../../packages/sdk/src/client.ts),
  [worker](../../packages/sdk/src/worker.ts) and
  [handler contract](../../packages/contracts/src/handler.ts).
- WooCommerce is part of Stage 4. The old H-12 expected concurrent SDK/Woo
  routing, which [the integration decision](../decisions/0036-a-merchant-sells-through-one-integration-at-a-time.md)
  explicitly prohibits. H now tests switching, blocked switches and abandoned
  approval rather than the deleted routing design.
- Address erasure from active records does not erase retained snapshots.
  Optional analytics refusal does not forbid essential consent/scan records.
  The relevant boundaries remain explicit in F and I.
- Some payment outcomes and obligations deliberately require intervention.
  “Nothing waits forever” would incorrectly turn uncertainty into a false
  unpaid claim. J and K test truthful uncertainty and the actual recovery path.
- An operator-recorded charge can leave a delivered order without a receipt;
  the operator command does not verify the payment on chain. J and K distinguish
  this from a late payment-layer answer, as the
  [receipt contract](../../packages/contracts/src/receipt.ts) requires.
- A manual refund does not record a refund in Agentify or stop later delivery.
  The [orders guide](../../apps/docs/orders.md) requires the merchant's handler
  and recovery loops to consult their own refund records. M-06 tests discovery
  of that responsibility, restart and work already in flight, not just the
  presence of a warning. D also checks the published card types against the
  engineer's real edit-and-republish workflow.

## Coverage strengthened

The central addition is evidence after a real effect, including an answer lost
after commitment. A process disappearing before commitment is not equivalent.
Merchant idempotency also needs a durable effect or the provider's own operation
record; a claim file followed by a log append has its own crash window.

High-risk stories now include payment ownership races on Postgres, historical
payout destinations, wallet changes on both sides of verification, actual
download bytes, Woo creation uncertainty and recovery, abandoned connection
grants, parcel address loss, old debts hidden by pagination, Google/email identity
continuity, stale-account registration, public-share consequences and deletion.
Scanner database flows and an actual wallet round trip cannot borrow a pass
from a browser walk over stubs.

The instrument requirements are deliberately visible. This change does not
build a response-cutting proxy, a new provider simulator or merchant fixtures.
A tester can distinguish executable public paths from fault variants that
need equipment before they start. A missing product recovery feature remains
a product finding rather than an equipment excuse.

## What is known about external discovery

The [August spike](04-spike-bazaar-listing.md) records one Base resource entering
discovery within twelve minutes of a payment. It explicitly belongs to an older
experimental service. The [commission experiment](47-commission-in-the-product.md)
left discovery with the split recipient untested. Neither proves today's
merchant-to-independent-buyer path.

The current [owner introduction](../../apps/docs/index.md) describes placing
goods in external catalogues, while the [quickstart](../../apps/docs/quickstart.md)
separates settlement from listing and disclaims automatic publication there.
L-01 evaluates what a newcomer actually believes, rather than assuming that a
later caveat cancels an earlier promise.

The [listing checker](../../apps/gateway/src/listing-command.ts) asks for a
challenge and validation, not discovery membership. The
[bootstrap command](../../packages/slice/src/bootstrap-command.ts) pays and
watches URLs, but drops metadata and cannot alone establish initial absence,
refresh or complete negative evidence. A repeat confirmed bootstrap can buy
again. L requires independent read-only observations and an actual buyer
starting at the external catalogue.

Coinbase's [seller guide](https://docs.cdp.coinbase.com/x402/seller/get-discovered),
read on 2026-10-18, distinguishes technical validation, metadata screening and
post-settlement indexing, and describes TEST discovery through CDP. Its
[buyer guide](https://docs.cdp.coinbase.com/x402/buyer/discover-services)
separates ranked search from paginated membership. These are provider claims
to test against the selected deployment, not Agentify acceptance evidence.

## Validation of this document change

The change is documentation only. Validation checks local links, scenario
identifiers and references, Markdown whitespace, and whether the scenarios'
expected outcomes agree with the cited contracts. Product tests are not
reported as passed merely because this plan was reviewed. An independent
adversarial review of the completed protocol is recorded in the pull request;
its findings and repairs are part of the review evidence.

## Independent review of the completed protocol

A fresh-context Astra reviewer at xhigh reviewed the completed protocol against
all of the product owner's criteria and the repository, without reading this
rationale. Its first verdict was revise, with four findings: changed-product or
changed-parameter payment replay was missing; manual refunds were not combined
with delayed fulfilment; the ordinary buyer's tooling was underspecified; and
facilitator discovery submission lacked a defined witness. J-04, M-06, buyer
preparation and L now address those findings. The second verdict was accept,
with no remaining blockers and no claim of product readiness.

After synchronising with the source revision named above, a third targeted
review checked the receipt exception, merchant-side refund coordination and
published card types. It accepted those additions and required one narrow
correction: J-08's successful operator-recovery variant must establish and
record a settlement, since the operator command refuses recording failure on
an open order. That correction is applied; the reviewer explicitly required
no further round for it.

A separate Sol 6.1 reviewer at xhigh read for UX. It required D-01 to separate
invalid contract input from a structurally valid card missing a real business
requirement. After that correction its verdict was that the UX half holds.
It also checked the final receipt, refund and card-type additions and maintained
that verdict without a further blocker.
Neither review executed product scenarios or converted a planned observation
into evidence of a passing product.
