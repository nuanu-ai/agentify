# Agentify test quality audit

The audit identifies five test weaknesses confirmed by surviving mutations and
one ineffective payment-secret exclusion check established from source. The
useful next step is to strengthen these existing tests. The evidence does not
support a broad deletion campaign, a product acceptance verdict, or a claim that
the production code currently contains the deliberately introduced defects.

The audited product revision is `77a9b578312e696826f378405c099f4996bcd703`.
Discovery and experiments took place on 27 October 2026 in an isolated worktree.
The permanent changes install the audit skill and record these findings;
production code and tests are unchanged. Each temporary mutation was restored
byte for byte before the next experiment.

## Scope and method

The [installed skill](../../.agents/skills/test-audit/SKILL.md) is adapted from
Peter Steinberger and OpenClaw contributors' `test-audit` at upstream revision
`3195fba90643c3897c538f2f6891c405331bee9c`. The original value and retention
criteria remain; Agentify commands replace unavailable OpenClaw tooling. The
package includes its MIT license and campaign guide. Codex discovers the
project's `.agents/skills/test-audit`, Claude has a symlink to the same package,
and `AGENTS.md` directs test work to it.

Three GPT-6.1 Sol agents used xhigh effort for independent owner-based discovery.
A Sol high reviewer challenged the findings and their claimed proof boundaries;
a Sol medium reviewer checked the skill integration. The parent examined
documentation and deployment tests and executed the mutations. Discovery read
tests, production owners, callers, overlapping proof, relevant dependency code,
history and CI routing for the reported candidates.

The inventory contains 424 tracked test files with 150,942 lines. It excludes
test-support modules, fixtures and configuration from that line count. There
were 125 complete test-file reads, 28 partial reads and 271 files receiving only
inventory or pattern discovery. A complete test-file read is not a verdict on
every declaration or its whole dependency graph. The exact depth and execution
lane of every file is in [inspection.csv](test-audit-2026-10-27/inspection.csv).

| Owner group | Test files | Complete reads | Partial reads |
| --- | ---: | ---: | ---: |
| Gateway, core, public contracts, SDK and purchase tools | 160 | 35 | 11 |
| Dashboard, combined application, shared UI, gallery and consent | 112 | 30 | 8 |
| Scanner, web, worker, browser actor and supporting packages | 134 | 48 | 6 |
| Documentation, deployment and operations scripts | 18 | 12 | 3 |

This is broad discovery with selected deep inspection, not the per-declaration
pruning campaign described in the upstream `CAMPAIGN.md`. No deletion savings
or whole-repository mutation score is claimed.

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
  proof must remain; the whole large worker suite was not read in this audit.
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
retained as independent platform contracts. Canonical-copy relationship tests
were retained after history showed they replaced brittle prose pinning and
caught removal of the actual headline lookup. The database test helper's
refusal of deployment databases protects operator data despite being test
support. A repository-wide CSS token declaration check establishes only that
a name is declared somewhere, not that a page loads the right stylesheet;
that limitation alone is not a justified deletion.

## Executed checks and limits

The [evidence record](test-audit-2026-10-27/evidence.json) contains exact commands,
mutation substitutions, source hashes, exit codes and test counts. Five
targeted mutations survived; the entrypoint short-secret control was killed at
the intended assertion. These are selected adversarial checks, not a random
sample from which a mutation score can be estimated.

The unmodified baseline passes 7,380 unit tests in 380 files, 14 operations
tests, 573 database tests in 26 files, 147 deployment tests and 14 network
configuration tests. Database execution uses a fresh disposable PostgreSQL
container matching CI's image digest; its temporary data and container are
removed after execution. All mutated owners are checked again after restoration.

The first local run used Node 24.21.0, a different version from `.nvmrc`.
Baseline checks and mutation evidence are repeated on the pinned Node 24.22.1
with pnpm 11.12.0; the local runtime archive is checked against the official
SHA-256 list and does not replace the system installation.

The eleven TypeScript integration files, browser/gallery lanes, scanner-specific
integration and migration commands, production builds, live merchant APIs,
facilitator and chain smoke were not executed for this audit. Passing local
tests does not establish product acceptance or live payment correctness.
No broad typecheck or dead-code run is required by the documentation-only diff;
both are necessary when a subsequent cleanup removes production seams.

## Delivery

The skill installation and audit travel together on `agent/test-audit` in
separate commits. No deployment tag moves, no merge and no test pruning are
part of this task. The production and test LOC delta is zero; new lines are
skill instructions, license and audit evidence. The independent reviews found
no actionable installation defect and accepted the five mutation-backed gaps
with the later-lane qualifications stated above.
