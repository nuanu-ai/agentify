# Cabinet and WooCommerce correctness results

The subject is `e11fef741e875ef6f9c42465a6b27577dd2921a1`, under the
[registered plan](plan.md). Product code is unchanged. The local connector
checks reproduce two inspection consistency problems, each for downloads and
parcels. Other completed checks preserve the product admission boundary,
publication identity, uncertain-creation ledger and exact-order recovery
boundary. These observations do not prove real payment settlement or delivery
from the deployed shop.

The reusable checks are [woo-campaign.test.ts](../../../apps/dashboard/src/woo-campaign.test.ts)
and [cabinet-campaign.test.ts](../../../apps/dashboard/src/cabinet-campaign.test.ts).
The [sanitized case ledger](cabinet-woo-evidence.json) records each collected
case and separates an expected failing assertion from an ordinary pass. The
four inspection cases use `it.fails`: green execution of those four means the
current implementation still violates their stated expectation.

## Execution and limits

The connector run collects 152 cases: 136 execute, including four expected
failures, and 16 are explicitly skipped. Its ordinary passing count is 132.
The recovery positive control is an exploratory validation extension
registered with the campaign lead before its run. No generated sampling is
implemented in these files; the three registered cabinet seeds remain unused.

| Matrix | Registered | Executed | Outcome and limit |
| --- | ---: | ---: | --- |
| Product qualification | 48 | 48 | Two unchanged lab shapes accepted; 46 unsupported mutations publish no card. |
| Catalog growth and failure | 27 | 21 | Normal and reachable altered pages pass. Six second-page alterations are inapplicable because counts 0, 1 and 99 terminate on page one. |
| Remote failure and redelivery | 36 | 26 | No second create POST or second committed order. Six class-inapplicable cells and four unimplemented gateway-response cells are skipped. |
| Exact-order recovery mismatch | 12 | 12 | Each mismatch remains unknown and refused, without creation or delivery. |
| Exact-order recovery positive control | 1 | 1 | A matching unknown order becomes placed and supplies one late delivery without creation. |
| Grant lifecycle | 24 | 24 | Six lifecycle inputs each use sequential, reversed sequential, concurrent-invocation and reversed concurrent-invocation strategies. This exercises the memory adapter; it proves no Postgres transaction interleaving. |
| Inspection consistency | 4 | 4 | Four expected failures, grouped into the two findings below. |

Growth sizes are 0, 1, 99, 100, 101, 199, 200, 201 and 1000. Pagination uses
the real catalog reader and import; persisted cards are read back from the real
gateway. A duplicate row counts toward the admission ceiling, so an overlapping
200-product catalog is conservatively refused. This is recorded behavior, not a
claim that an inconsistent upstream pagination response must be repaired.

Remote failure points are the protected inspection, raw-file protection,
shipping rate, create before commitment, create after commitment, and loss of
the validated fill result before redelivery. The transport classes are timeout,
HTTP 429 and malformed successful document. Raw-file checks do not apply to
parcels, and shipping checks do not apply to downloads. The result-loss seam
does not exercise gateway HTTP 429 or malformed gateway success: those four
cells remain unimplemented. Shipping failures use the cart-result seam; the
real Woo cart HTTP sequence is not claimed as covered. The document server
keeps received create POSTs separately from committed orders. Both remain at
most one per sale, even when a committed creation loses its response.

The 24 grant invocations include identical commit linearizations in the
synchronous memory implementation. Sequential and concurrent invocation are
distinct calling strategies, not 24 unique database races. No database test is
run here.

The 64 form cells are a follow-on matrix: eight actions times four request
contexts times two merchant positions. The contexts are accepted repeat,
absent session, stale form with the other merchant's session, and wrong Origin.
The accepted context submits the same form twice, giving 80 planned HTTP POSTs.
Key issuance deliberately creates two keys; the other repeats are expected to
preserve their first completed state. The missing-marker context from the
initial proposal is replaced by wrong Origin, and missing/duplicate-marker
checks are not claimed by this file. Each cell uses new local accounts and
compares both merchants' persisted gateway and connection state.

The local execution environment refuses a loopback listener with `EPERM`, so
that initial form run executes no cells. The lead's first listener-capable run
finds a fixture setup error before every form: the mail sink is keyed by a
normalized lowercase address while the test looked it up with an uppercase
label. The fixture is corrected. The lead's rerun passes all 64 cells and
completes the 80 planned POSTs. Setup failures are not product findings.

The 48 generated interface traces of 12 operations are implemented in
[navigation-campaign.integration.test.ts](../../../apps/dashboard/src/navigation-campaign.integration.test.ts)
and pass all 48 traces in the lead's listener-capable environment, completing
576 logical operations with no failed or skipped traces. Their extension is registered before
execution: the three base seeds each derive sixteen trace seeds with
`uint32(base XOR imul(trace + 1, 0x9e3779b9))`. Each trace uses a fixed twelve-
operation skeleton, with seed-selected viewport, initial account, navigation
targets, seller name and initial selling state. The operations cover client
navigation, intent prefetch, selling mutation, reload, seller-name mutation,
Back, Orders filtering, a held Receipts response superseded by Orders, an
account switch followed by a stale form, reload as the new account, signout in
a second tab followed by reload, and return to the original account. The
oracle compares visible account identity, form owner marks, card identity and
persisted gateway state. The delay uses an explicit response barrier. These
are parameterized traces, not arbitrary event permutations. Wallet-provider
checks are assigned to the API agent and are not included in this report's
counts. The [navigation report](navigation-results.md) and its seed ledger
describe the observations and limits.

## C-WOO-1: inspection accepts a document naming another product

Priority: P2 correctness. The parser requires a positive `id`, but the product
inspector never compares it with the identifier requested in the URL. Asking
for product `1` and returning an otherwise valid product document with `id: 2`
produces `ok: true` and an eligible product whose `productId` is `"1"`. Both
download and parcel variants reproduce it. The unchanged `id: 1` controls pass.

Minimal reproduction: run the targeted tests below, or call
`inspectProductInTheShop` with the same-origin product identifier for `1`,
valid class settings, and a product response whose only changed field is
`id: 2`. A download's raw file returns 403. The expected refusal is instead
an affirmative eligibility result for the requested identifier.

```sh
pnpm exec vitest run --project unit apps/dashboard/src/woo-campaign.test.ts \
  --maxWorkers=1 --no-file-parallelism -t 'refuses another product'
```

The consumer consequence is that an explicitly mismatched upstream document
can supply eligibility, price and download facts for another item. The
inspector's affirmative result labels those facts with the requested item.
This campaign does not demonstrate a stock WooCommerce server returning such
a mismatched document or an end-to-end wrong-goods delivery. The finding is
about response validation at an existing connector boundary.

Source: `apps/dashboard/src/woo-shop.ts`, `ProductSchema` at line 118,
`inspectProductInTheShop` parsing around lines 225–234, and its fingerprint/
eligible-result construction. The exact failing checks start near line 425
of `woo-campaign.test.ts`.

## C-WOO-2: a setting irrelevant to the product class can stop inspection

Priority: P3 availability. The inspector's comment says only settings bearing
on a product's class decide eligibility. It fetches all ten endpoints through
one `Promise.all`, however, and a transport rejection aborts that batch before
class filtering. A valid download with only its shipping-destination request
lost becomes `ok: false, again: true`; a valid parcel with only its download-
login request lost has the same outcome. A refusal response from an irrelevant
endpoint is filtered later; a rejected transport promise is not.

Minimal reproduction: use either unchanged positive product fixture, and throw
only when the request path ends in `woocommerce_ship_to_destination` for a
download or `woocommerce_downloads_require_login` for a parcel. All
class-bearing product/settings documents remain valid. The inspector returns
“The shop did not answer the protected product check.”

```sh
pnpm exec vitest run --project unit apps/dashboard/src/woo-campaign.test.ts \
  --maxWorkers=1 --no-file-parallelism -t 'class-irrelevant setting'
```

A merchant can lose a supported product's import/availability because a
request their product does not need fails. Paid-order consequences are not
independently exercised for this precise irrelevant-setting input. Source:
`apps/dashboard/src/woo-shop.ts`, the class-bearing-settings comment at lines
136–139 and the common request batch/catch at lines 168–180. The targeted
checks start near line 435 of `woo-campaign.test.ts`.

Both findings are replayed outside Vitest with a separate stdin program using
`node --import tsx`, directly importing the source inspector. It produces six
sanitized observations: two accepted controls, two accepted mismatched IDs and
two irrelevant-setting refusals. Those values are retained in the case ledger.
The `tsx` CLI's IPC listener is unavailable in this execution environment;
using Node's import loader avoids that unrelated listener requirement.

## Verification and remaining acceptance

The connector command is:

```sh
pnpm exec vitest run --project unit apps/dashboard/src/woo-campaign.test.ts \
  --maxWorkers=1 --no-file-parallelism --reporter=json \
  --outputFile=/private/tmp/agentify-woo-campaign-final.json
```

The new files pass the dashboard TypeScript check and Biome check. Product
source hashes in the evidence match the registered subject. The initial
connector run's 41 failures are harness errors: the document server matched
`/settings/products/...` as a product URL, and a readback assertion ignored the
merchant-card wrapper. The corrected positive controls and full reruns pass;
none of those 41 failures is counted as a product defect.

No deployed host, external account, real shop, mail provider or chain is
contacted by these connector tests. There is no mutation self-check or
independent reviewer signoff in this subtask's evidence yet; those remain
campaign-level acceptance work. No product fix or commit is made here.
