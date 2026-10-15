# Agentify adversarial correctness campaign

This plan is registered before campaign experiments. The subject is commit
`e11fef741e875ef6f9c42465a6b27577dd2921a1`. Test additions live on
`agent/fuzz-campaign`. Product implementation remains unchanged so that a
failure continues to reproduce against the subject. The user grants exclusive
control of TEST and the disposable WooCommerce lab for this campaign, including
deployments, resets and recovery, and authorizes their mailbox for test login.

## What a result means

The campaign checks promises visible to an external merchant and buying agent:
accepted data remains usable, unauthorized actions preserve state, one paid
order does not become two charges or two fulfillments, uncertain outcomes stay
uncertain, and the cabinet describes persisted state truthfully. A completed
HTTP request, green unit test, receipt, or successful deployment proves only its
own observation. Local payment doubles do not prove signatures or settlement.

The input space is infinite. This plan enumerates finite equivalence classes,
exhausts high-risk small intersections, and uses reproducible generated traces
for the larger spaces. Counts mean logical cases, traces and transitions as
separate units. Pairwise coverage is claimed only with an enumerated pair
inventory and covered-pair count. Generated sampling is never called exhaustive.

## Common dimensions and selection

| Dimension | Classes | Selection |
| --- | --- | --- |
| Data shape | absent, null, wrong scalar, wrong container, empty, valid, undeclared field | All required fields and representative optional fields |
| Boundaries | min-1, min, min+1, max-1, max, max+1, fractional, unsafe integer | Each applicable declared bound |
| Text | ASCII, Cyrillic, composed/decomposed Unicode, surrogate, whitespace, control, markup-looking, long | Seeded schema and wire cases; no execution of untrusted content |
| Actor | anonymous, merchant A, merchant B, expired/revoked identity, stale browser form | Exhaust critical state-changing doors |
| Merchant mode | SDK, Woo, disconnected, switching, pending orders | Mode transitions and same-merchant pending work |
| Order | every reachable state, four fulfillment modes, price check on/off | Stateful generation plus critical permutations |
| Time | same timestamp, deadline-1, deadline, deadline+1, distant future | Boundary cells and deterministic scheduling barriers |
| Delivery | once, duplicate, late, reordered, partial batch, handler exception | Model traces and worker schedules |
| Transport | correct response, declared refusal, malformed success, empty body, truncation, pre-header loss, 429, 503, timeout | Consumer and connector matrices |
| Scale | 0, 1, 10, 99, 100, 101, 199, 200, 201, 1000 | Surface-specific thresholds; input cap 256 KiB |
| Browser | fresh/reused session, two tabs, reload/back, delayed navigation, account switch, desktop/mobile | Fixed real-browser traces and local integration tests |

A new case discovered during execution is an exploratory extension, recorded
before its own run with its reason and oracle. A failing expectation is checked
against the current public contract and independently reproduced before being
called a defect. No test may assert mock behavior as the product promise.

## Work packages

Three agents use `gpt-6.1-sol`, reasoning `xhigh`. Root owns the shared deployed
environment and browser. Agents execute only local bounded suites, with one
Vitest worker each and separate files. They do not deploy or spend. An initial
API inventory task encountered a service cybersecurity-risk filter; its revised
scope is offline validation/serialization correctness. This limitation is kept
in the report rather than being hidden as coverage.

### API and contracts

Seeds `0xA61015A1`, `0xA61015A2`; 350 logical cases, loopback only.

* 256 schema cases: eight families times 32 cases (card, purchase, poll, key
  issue, merchant settings, quote answer, handler answer, order query).
* 64 accepted-card round trips: two documentation variants times 32 canonical
  spelling/default combinations. Parse, publish, merchant readback, public
  projection and discovery challenge must agree on accepted information.
* Six complete-list comparisons: public and merchant lists at 1, 10 and 100
  cards; compare identity sets and content, without inventing an ordering rule.
* 24 malformed JSON requests: six forms times four existing POST doors. Expect
  the documented nonretryable malformed-body response and no accepted write.

Root separately measures discovery-header compatibility for accepted parameter
counts 1, 32, 64, 128, 256, 512, 1024 and 2048, each bounded to 256 KiB. The
oracle is whether a normally configured HTTP client can read the purchase
challenge for an accepted card. This is a compatibility experiment, with byte
sizes and the client's actual limit reported.

### SDK and order state

* 512 reachable traces: four fulfillment modes times two price-check modes
  times 64 seeds; 128 events each, totaling 65,536 attempted trace steps.
  Seed is uint32(`0xe11fef74 XOR imul(i+1,0x9e3779b9) XOR cell`). Generation
  uses all available event kinds, boundary times, repeated and late events.
  An independent effect ledger checks payment, goods, receipts and debt.
  Reachability and rejected candidates are reported separately. All 16 states
  and money effects are the requested coverage floor; a gap is incomplete.
* 108 critical schedules: six event triplets times six permutations times
  three deadline positions, starting from reachable checkpoints. Groups cover
  synchronous delivery, settlement uncertainty, asynchronous delivery, debt,
  parcel dispatch, and delivered-but-unpaid retry. Event order may legitimately
  change the outcome; no unsupported commutativity assumption is made.
* 360 SDK consumer cases: six callable routes times ten response/fault classes
  times six representative inputs. No implicit mutation retry, truthful error
  classification, route and subject preservation, and builders without I/O.
* Up to 144 worker schedules: three message classes times four handler/fault
  classes times three stop phases times two batch suffixes. Barriers replace
  timing guesses. Stop must cease polling and unread dispatch, and restart
  must retain handlers. A handler that never finishes is assessed against the
  documented stop contract, not automatically called a product defect.

Per-suite initial wall budgets are 90 seconds for model/schedule suites and
120 seconds for consumer transport, with one worker. Budget exhaustion is an
incomplete run, not a passing result. Harmless harness timeout corrections may
be registered and rerun, retaining the original evidence.

### Cabinet and WooCommerce

Seeds `0xC61A0001`, `0xC61A0002`, `0xC61A0003`.

* 64 authorization/form cases: eight actions times four session/form contexts
  times two merchants. Compare state before/after, not status alone. Missing
  identity, stale form and wrong origin have different documented responses.
* 48 generated interface traces of 12 operations: navigation, refresh, back,
  filtering, mutation, signout and account switch. Check latest owner/state
  after settled action and revalidation. Implement only traces the harness can
  independently observe; unsupported UI traces remain explicitly unexecuted.
* 48 product qualification vectors across the lab download and parcel shapes,
  product kind/status/stock/price/file policy and shop settings.
* 27 growth/failure vectors: nine counts times normal, overlapping pages, and
  later-page failure. The 200-product admission boundary must refuse without
  partial publication; repeated logical products must not duplicate cards.
* 36 remote failure vectors: six relevant failure points times three outcomes
  times two product classes. Twelve exact-order recovery field mismatches.
  Never blindly repeat a possibly committed order creation; binding and quote
  facts remain durable and monotone. Class-inapplicable cells are identified.
* 24 callback/race schedules: six grant lifecycle cases times four orders.
* Four targeted inspection cases: response product ID differs from request
  for each product class; transport failure on a class-irrelevant setting.
* Wallet provider response checks use the real component with a local provider
  boundary: rejected, malformed-success, accepted-pending and successful
  submission must not be conflated with confirmed on-chain payout.

## Root integration and deployed evidence

Before mutation, record local/deployed SHAs, image labels, container health,
campaign wallet balances and an application/fixture restore point. Preserve
secrets on their owning host or ignored mode-600 local files. Verify the dump
is readable and retain a recovery procedure. Do not copy keys, magic links,
cookies, payment signatures or download capabilities into artifacts or logs.

Deploy the exact subject through the existing TEST release command only when
its image build is ready. Record successful public route checks and actual
image revision. The initial TEST revision may differ; results from different
revisions must never be combined without a label.

Root real-browser subset is eight traces: email sign-in and reuse; fresh and
stale tab after signout; form resubmission; navigation during delayed data;
reload/back after a mutation; desktop/mobile listing; integration connect and
denial/reconnect; truthful pending/failed payout display. Use the authorized
mailbox and campaign aliases only. Limit email-generating actions to 12.

Deployed API probes use two dedicated merchants, realistic lab artifacts and
existing public doors. Cap requests at 2,000, concurrency at four and sustained
rate at five requests/second. Check anonymous access, owner isolation, revoked
keys, catalogue/readback parity, malformed inputs, SDK handler delivery and
repeat status reads. Bulk combinatorics and large inputs stay local.

The live purchase allowance is at most 40 signed authorizations, each at most
0.01 Base Sepolia test USDC, and at most 0.40 test USDC total. The initial buyer
has 2.952 test USDC and zero ETH. The merchant has a separate generated test
wallet. Gas allowance is at most 0.0005 test ETH. Reserve a payment before
signing, including unknown/crashed attempts. A persistent ledger prevents
parallel agents or restarts from resetting the cap. Pin chain 84532 and the
canonical test USDC address, allowed recipient/card and exact accepted quote.
No mainnet operation, real-money purchase or paid infrastructure is authorized.

Test both a controlled SDK merchant and Woo download end to end: discovery,
quote, payment, fulfillment, status/receipt, actual downloaded bytes, and
merchant payout when test gas is available. Exercise unpaid refusal, duplicate
read/redelivery, connection-key failure and recovery without another charge.
Fault injection touches only TEST app/Woo components. Agentify, Woo and an
unrelated service share a host, so no host shutdown, broad firewall change or
host-wide resource exhaustion is part of this campaign. Restore altered
settings and verify healthy routes and owned test state at closeout.

Inventory scanner HTTP doors as a second wave because they share the public
site. Reuse the existing local integration suite and add bounded schema/error
cases if the commerce-oriented first wave leaves exposed routes uncovered.
Do not launch third-party paid scans. Clearly separate scanner coverage from
commerce coverage in the final matrix.

## Evidence, review and completion

Keep a sanitized case ledger with case/seed, actual count, command, revision,
expected observation, actual observation, result and evidence file. Each defect
has a minimal reproduction, consumer consequence, severity, source location
and independent replay. Distinguish product failure, harness failure,
environment failure, unsupported contract assumption and unexecuted case.

An independent agent reviews the new checks and candidate findings. Mutation
self-checks use a temporary isolated copy and record killed, survived or did
not apply. Negative controls and an outside-fixture SDK run guard against a
self-confirming harness. Do not mutate the product on the deployed subject.

Deliver the plan, reusable tests, sanitized evidence and report through one
branch/PR. Product fixes are outside this campaign. Completion means every
matrix cell has an honest final status, findings have independent evidence,
resources are recovered and remaining gaps are named. It does not mean a
claim that every possible input was tested.


## Execution amendments and final disposition

The registration above remains unchanged. The completed report names each
executed, inapplicable and unexecuted cell. The worker expression contains an
arithmetic error: 3 × 4 × 3 × 2 is 72, despite the written ceiling of 144.
There are 34 distinct meaningful executed worker schedules. Seventy-two SDK
transport-loss cells are replaced before their execution with 429-envelope
and complete-response truncated-JSON cases; actual loss before headers and
mid-body remains unexecuted. WooCommerce has 16 explicit skipped cells,
including four applicable remote-fault cells that remain unexecuted.

The wallet extension executes 20 cases against the real component. The live
confirm-mode experiment checks its current pilot rejection before signing.
Two unsigned Woo quote probes extend the original purchase flow to test an
invalid connector secret and recovery. The first probe races a worker already
waiting with the prior connection; the corrected experiment lets one poll
interval finish before either request. A completed purchase survives a TEST
application restart; this is not a test of process loss during a paid order.

The payout verifier receives an initial receipt with a zero block hash and
keeps it inconclusive. A read-only verification of that same transaction
resolves its canonical receipt; no second payment is sent. A second merchant's
payout then executes and verifies separately. These observations are retained
in the evidence rather than being erased by retries.

The final matrix also inventories the scanner's 55 route declarations and
executes seven existing local browser-actor integration cases. It does not
claim a new scanner fuzz matrix or a full PostgreSQL adapter differential
campaign. Deployed browser combinations without an execution ledger stay
unexecuted even where their local Chromium counterparts pass.
