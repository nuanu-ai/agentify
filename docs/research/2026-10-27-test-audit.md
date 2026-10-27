# Agentify test quality audit

Every collected test case now has an individual decision: 6,642 retain,
857 repair, 343 consolidate and 603 delete candidates out of
8,445 cases. A repair decision preserves a needed consumer promise; it is not a
recommendation to delete the test. Consolidation requires moving the named
unique assertions before retiring their old declaration. The suite's size alone
does not establish waste, and these counts are not execution-time savings.

The per-test register is a local working artifact for implementing the audit
decisions, stored outside the repository. Its HTML view provides search and
filtered export; its JSONL records contain every case, source, verdict, reason,
production owner and keeper. This report preserves the conclusions and
reproducible evidence. Artifact hashes are recorded in the evidence file.

The audited product revision is `77a9b578312e696826f378405c099f4996bcd703`.
The report combines complete source review with five surviving targeted
mutations, one killed mutation control, and a separately reproduced defect in
the bootstrap purchase command's handling of a lost signed response. It is not
a whole-suite mutation score or product acceptance. Production code and test
files are unchanged; temporary mutations were restored byte for byte.

## Scope and method

The [installed skill](../../.agents/skills/test-audit/SKILL.md) is adapted from
Peter Steinberger and OpenClaw contributors' `test-audit` at revision
`3195fba90643c3897c538f2f6891c405331bee9c`, with its license and campaign guide.
Agentify commands and authority rules replace OpenClaw-specific tooling.
`.agents/skills/test-audit` is the project skill; `.claude/skills/test-audit` points
to the same package, and `AGENTS.md` routes test work to it. Its junk-pattern
checklist explicitly includes self-comparisons, derived expected values,
implementation assertions, copied inventories, test-only seams and mocks that
supply the behavior being asserted.

The inventory reconciles 424 tracked test files (150,942 lines), seven shared
declaration modules and five wrapper-only test files already included in the
424. All 431 relevant files have complete source-inspection records. There are
6,310 declarations: 6,286 register active cases and 24 are conditional diagnostic
markers for an unavailable test database. Those markers receive N and do not
inflate passing tests or deletion candidates. One AST false positive,
`woo-recovery.test.ts:536` (`test.sold.map`), is excluded rather than counted as a
test. The external working register includes the file-level execution and
inspection map and each file's source hash.

| Decision | Declarations | Collected cases |
| --- | ---: | ---: |
| Retain (R) | 5,150 | 6,642 |
| Repair (F) | 622 | 857 |
| Consolidate (C) | 307 | 343 |
| Delete candidate (D) | 207 | 603 |
| Environment marker (N) | 24 | 0 |
| Total | 6,310 | 8,445 |

All declarations, their assertion bodies and nested table/loop inputs were read
with their production owners, callers and overlapping proof. Runner collection
supplies exact expanded names: 7,380 unit, 573 database, 317 integration, 14 Node
operations and 161 Python cases. Shared contract declarations map to each actual
memory/PostgreSQL invocation. There are zero unmapped cases and zero unreviewed
declarations. Mixed parameter tables have 117 explicit runner-row
overrides; loops inside one runner case remain described inside that declaration,
not invented as extra test runs. A passing baseline is independent of a quality
verdict: a passing F test can still miss the regression it names.

GPT-6.1 Sol agents used xhigh for broad owner audits and full-suite analysis;
the earlier independent findings reviewer used high, and the skill integration
reviewer used medium. The parent completed documentation, deployment, shared
packages, operator surfaces and the web lanes, reconciled the inventories and
ran the adversarial experiments. A separate bounded adverse review checked 38
C/D decisions and their actual keeper assertions; it is a second check, not the
basis for the exhaustive first pass. Review corrections preserve all database
selection safety cases and repair a mistaken keeper for two-wallet derivation.
A final Sol high reviewer independently verifies the complete register, source
hashes, effective decisions, keeper references, report links and viewer parity.

## A real defect concealed by a preclassified test outcome

`packages/slice/src/bootstrap-command.test.ts:320` supplies
`{ kind: "unreachable" }` directly and verifies the resulting unknown-payment
message. The production network boundary in `bootstrap-command.ts:1091–1111`
records a signed request only after `await fetch(request)` returns. If that
signed exchange throws, the catch at lines 1196–1214 sees no recorded signed leg
and returns `client_refused`, which the command reports as no charge.

The [offline experiment](test-audit-2026-10-27/bootstrap-loss.mjs) exercised the
actual x402 wrapper and local signing with the public devnet key already in the
existing test fixture. Every fetch was intercepted; there were zero external
requests, no payment and no source mutation. Its
[recorded output](test-audit-2026-10-27/bootstrap-loss.json) shows both controls:
unsigned transport loss correctly returns `client_refused`; after observing a
signed request, transport loss incorrectly returns the same refusal and says
nothing was charged. The expected second result is `unreachable`/unresolved.
All 61 existing tests in that owner file still pass. This establishes a defect
in the diagnostic command, not an observed live loss of funds. The audit records the needed repair; it does not change payment code.

## Findings requiring stronger proof

### 1. Payment replay checks can ask about the wrong nonce without failing

In [payment-chain.test.ts](../../apps/gateway/src/adapters/x402/payment-chain.test.ts),
lines 39–41 answer every non-`eth_chainId` request with the same selected result.
The used/unused cases at lines 111–117 therefore verify response interpretation
without verifying which authorization was queried. Replacing the nonce passed
to `readContract` with an all-zero nonce leaves all ten tests green.

The real caller in `app/returning-payment.ts` supplies the token, wallet and
authorization nonce; viem ABI-encodes those arguments into the RPC request.
Higher-level replay tests inject a `PaymentChain` verdict and do not exercise
this encoding boundary. The current production adapter passes the correct
arguments. The tests date to the replay-protection work in `a0691ba5` and
`a87dd751`; they remain necessary security proof.

Keep the used, unused and unavailable cases. Make the loopback RPC fixture
distinguish independently specified token, selector, wallet and nonce inputs,
and return different results for different authorizations. The existing owner
test should kill the all-zero-nonce mutation; no new production hook is needed.

### 2. WooCommerce TLS preservation is asserted above the transport

The test at [woo-request.test.ts](../../apps/dashboard/src/woo-request.test.ts):113
observes a URL and address passed to an injected `open` callback. It cannot see
the native HTTPS socket options chosen by `openPinned`. Its
[transport sibling](../../apps/dashboard/src/woo-request-transport.test.ts)
substitutes `https.request` but does not check its TLS server name. Changing
that name to `wrong.example` leaves all 25 tests in the two files green.

The request adapter serves real catalog and order operations through
`woo-shop.ts`, `woo-catalog.ts` and connection checks. The original network
boundary was introduced in `0b65cbbd` / `4ff04616`. Preserve its independent
private-address refusal, IPv6, client-identity and response-handling tests.
The production factory itself has a real caller and is not a dead seam.

Assert the native socket address, original TLS name and HTTP Host header in
the existing transport suite. This verifies the caller's contract with Node's
HTTPS API; it should not be presented as a live shop or TLS-handshake test.

### 3. Synchronous analytics fakes conceal premature completion

The retry test in [analytics-client.test.ts](../../apps/web/lib/analytics-client.test.ts):91
throws synchronously, while the production senders in `analytics-delivery.ts`
are asynchronous and PostHog initialization awaits an SDK import. Removing
`await` from `sender(input.eventId)` leaves all five tests green. Under that
mutation a later rejection can arrive after the once-key has already been
stored, preventing the failed destination from being retried.

The production await is present and correct. Commit `89c65190` changed rejected
promise fakes into synchronous throws while removing mock-call assertions;
losing the asynchronous boundary caused the proof gap. The runtime consent
tests exercise a distinct entry point and do not replace this failure-ordering
contract.

Use a controlled pending promise in the existing test: no once-key while
delivery is pending, no once-key after asynchronous rejection, and a retry only
for the failed destination. Preserve independent consent and event-ID proof.
Completion here means completion of Agentify's sender callback, not acceptance
by a remote analytics service. The SDK import promise is cached, so this finding
does not establish successful recovery of a rejected import on the same page.

### 4. Positive entrypoint tests do not establish that the command starts

The two success cases in
[scanner-entrypoint.test.mjs](../../ops/scripts/scanner-entrypoint.test.mjs):30–38
provide a child command that exits zero and assert only the entrypoint's exit
status. Replacing the script's final `exec "$@"` with `exit 0` leaves all 14
operations tests green, even though the supplied server command never runs.

The script is the scanner image's actual `ENTRYPOINT`. The built-server test
starts Node directly and bypasses it. Real-image activation in
`deploy/activate.sh` separately checks process liveness and can catch this
regression at deployment; that smoke was not run during this audit. This is a
missing early regression check, not evidence that every later safeguard fails.
The entrypoint test file was introduced with the deployment-image move in
`2ae965238`.

Make the existing success fixture produce an observable marker and prove
argument and exit-status propagation. Keep the environment refusal checks.
As a control, weakening the signing-secret minimum from 32 to 1 failed exactly
the short-secret test, showing that the same suite does detect that guard.

### 5. Missing Markdown conditional openers satisfy an ordering assertion

In [markdown-copy.test.ts](../../apps/docs/app/markdown-copy.test.ts):52, a missing
opener has index `-1`, which still compares less than the disclaimer text's
index. Removing the opener from `markdownCopy` while keeping the closing
`end` leaves all ten documentation unit files and 155 tests green. The rendered
HTML test in `markdown.test.ts` contains the same fragile comparison shape,
although that separate rendering path has other coverage.

Both tests originate in the documentation pipeline work at `20dbdfc9`. The
Markdown writer is used by the real documentation build. Its Chromium lane
serves the generated Markdown through `fillTemplates`, which rejects an `end`
without an opening `if`; that later lane appears capable of catching this
specific mutation. It was inspected, not executed, under mutation.

Require both markers and content to exist before comparing their positions, or
exercise the generated conditional with the existing template consumer for
both identity settings. Keep the HTML and Markdown contracts separate: they
are independently generated outputs.

### 6. A payment-secret exclusion checks a value absent from its fixture

In [data-copy.test.ts](../../apps/dashboard/src/data-copy.test.ts):296–310 the
secret-exclusion loop includes `SECRETS.payment`, but the fixture never stores
that value. It stops at `beginPurchase`, before a payment authorization is
presented. The opaque `StoredOrder.payment` is null; it is distinct from the
public payment-state enum that the copy legitimately includes.

The real copier is constructed in dashboard `start.ts`. Its PostgreSQL sibling
tests identity-table selection, not this gateway payment-secret boundary.
The unused sentinel arrived with the exclusion test in `581b4efb`. This finding
is based on fixture and owner inspection; no payment-copy mutation was run.
It does not establish that the current copier leaks anything.

Retain the useful session, OAuth, API-key and shop-key exclusions. Create a
pending authorization through the existing store boundary and verify that the
source record actually contains the sentinel before asking for the copy. The
resulting negative control must fail if the opaque authorization is exported.

## Small consolidation candidates

These are source-backed follow-ups, not deletion patches. Any cleanup needs
rediscovery of its full caller set and preservation of the named contract.

- `woo-worker.ts:97–102` exposes a test-only `Filling.quotedSale` hook beside the
  existing `shops.quotedSale` port. Normal startup uses only the latter. Move
  controlled quote faults onto that existing port and keep real recorded quotes
  for successful fulfillment cases. Currency, binding identity and recovery
  proof must remain; the full worker suite is now individually classified in the register.
- `analytics-client.test.ts:12` exercises optional absent consent in
  `recordThenDeliverWithConsent`, while its sole production caller always
  supplies a snapshot and the runtime returns before loading delivery without
  consent. The runtime behavior suite owns that real boundary. Remove the
  unreachable optional branch with its test only after preserving
  record-before-delivery ordering at the actual caller.
- `registration-form.test.ts` tests exported private text helpers. The DOM
  suite already proves cooldown and button behavior, and `link-answer.test.ts`
  owns duration formatting. Move the unique submitted-address confirmation
  assertion into the DOM success case before retiring any helper export.
- `core/orders/redelivery.test.ts:77–84` compares two identical calls. It catches
  some nondeterminism but accepts stable wrong answers. Prefer the existing
  independently expected retry/deadline cases; do not infer that all possible
  determinism regressions are covered or remove the production retry helper.

## Proof that should remain

Static checks are not automatically low-value. Migration journals protect
upgrades of existing databases; package/export tests protect published SDK
surfaces; generated JSON Schema is exercised through independent Ajv
validation; memory and PostgreSQL suites test distinct storage implementations.
Money, closure, recovery, SSRF, consent, browser accessibility, actor output
privacy and dependency-backed deployment compatibility have separate contracts.

The browser `pattern` checker, Apify metadata and pg-boss schema checks were
retained as independent platform contracts. Canonical-copy tests protect a needed headline/fallback promise, but their
current relational or subject-derived oracles are classified F. They need
independent expectations; moving away from full prose pinning did not by itself
make those checks sufficient. The database test helper's
refusal of deployment databases protects operator data despite being test
support. The full register distinguishes stylesheet inventory from actual browser layout,
accessible controls and loaded-resource behavior; each decision names the
specific consumer promise or its absence.

## Removal dependencies and priorities

Start with incorrect money/identity claims and ineffective security negatives,
including the demonstrated bootstrap outcome, payment nonce lookup, WooCommerce
TLS name and data-copy secret sentinel. Repairing these changes what a green
suite means. The per-test register identifies the remaining weak cases across
startup, HTTP, storage, browser behavior, analytics and scanner policy.

Consolidation and deletion decisions are conditional where the register says
so. Populated migration fixtures must first cross the real 0007–0013 sequence;
an empty-database migration keeper does not prove an old credential was renamed.
Test-only unscoped key revocation must be replaced with the actual scoped store
operation while preserving the cross-process race. Database target selection,
precedence and password redaction protect the operator running `pnpm test:db`;
they are F/C at the real command boundary, not disposable helper self-tests.

The register is a decision proposal, not a ready-to-delete list. R means a
credible distinct regression is covered by the inspected assertions; it does
not certify that every conceivable mutation is killed. Removing a test after
its source changes requires rechecking its keeper and relevant owner suite.
No target deletion count, coverage percentage or estimated runtime reduction
is used to decide whether a test matters.

## Executed checks and limits

The [evidence record](test-audit-2026-10-27/evidence.json) contains exact baseline
commands, source hashes and mutation substitutions. The unmodified pinned
Node 24.22.1/pnpm 11.12.0 baseline passed 7,380 unit tests, 14 operations tests,
573 database tests, 147 deployment Python tests and 14 network-configuration
Python tests: 8,128 in total. The database run used a fresh disposable PostgreSQL
container matching CI's image digest, subsequently removed. Mutated owners were
verified again after byte-for-byte restoration.

`pnpm build` also passed, including the portal's seven actual example/program
render checks. Unit/database/integration collection was reconciled with source
locations; the 317 integration cases were collected and source-reviewed, not
executed locally during this audit. CI and Images were green at audit head
`78b2587d055ad0b2ee8944132c2a2c4e11498cb6` (CI run 40465957954, Images run
40465867008), including their browser lanes; that does not turn source review
into a local integration run or establish live merchant/payment acceptance.

Five selected mutations survived and the short-secret control was killed.
There was no mutation campaign over all 8,445 cases. Live merchant APIs,
facilitator/chain smoke and deployment activation were not run. No spending,
production database access or deployment-tag movement occurred. The first local
baseline used Node 24.21.0; reported baseline/mutation results were repeated on
the pinned runtime, whose official archive checksum is recorded in evidence.

The full register is validated for unique declaration/case IDs, complete file
coverage, nonempty decisions, resolvable keepers and exact runner totals. The
HTML viewer is checked for loading, filtering, source links and export. The
repository check also passes (`pnpm check`: 1,318 files, 21 existing warnings
and one informational diagnostic), and `git diff --check` passes. The only
permanent changes are skill instructions and audit artifacts; production
and test LOC delta remains zero.

## Delivery

PR #210 carries the skill installation, audit conclusions and reproducible
evidence. The complete per-test register and file inventory are working
materials stored outside the repository for subsequent repairs and pruning.
No merge, deployment, pruning or product repair is included. The original
targeted experiments remain available with their precise limitations.
