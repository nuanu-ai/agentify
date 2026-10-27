# Agentify test quality audit and remediation

The campaign addresses every actionable decision from the complete audit of
`77a9b578312e696826f378405c099f4996bcd703`: 1,138 declaration subjects,
including two retained declarations with individual deletion rows, and all 117
explicit parameter-row overrides. Every original test keeps its original
verdict and a separate implementation record. The signed-response payment bug
is repaired, weak assertions have concrete failure controls, and redundant
proof and its unused production seams have been removed.

The complete local validation ran on `f1a93bbb00b33568312552ebfd2668ac9e9c6a49`.
That revision incorporates main `a1fbdf1b61e966e392e9dc3a7983bd1a4a28e8fc`, including the
new worker-admission, purchase-recovery, commission and cursor contracts.
Independent reviewers compared both parents with the combined result.

## Complete coverage and working register

The original audit read all 424 tracked test files and seven shared declaration
modules, including assertions, parameter tables, production owners and callers.
Its 6,310 declarations register 8,445 cases; 24 declarations are unavailable-DB
markers rather than passing tests. The case decisions are 6,642 retain, 857
repair, 343 consolidate and 603 deletion candidates. These are judgments about
proof, not permission to delete a useful contract or a target test count.

The external companion directory `Agentify-test-audit/2026-10-27/` contains
`full-audit.html` and `full-audit.jsonl`. The viewer separates the original
reason from what was actually repaired, consolidated, deleted or retained.
`remediation/reconciliation/original-decision-completion-registry.jsonl`
contains all 6,310 declarations and 8,445 cases, with keeper and evidence
references. Reconciliation has no missing actionable subject or row override.
The register remains outside the repository; it is a working instrument for
following individual decisions. The repository retains this report, the skill
and the small original reproduction artifacts.

The [installed skill](../../.agents/skills/test-audit/SKILL.md) is adapted from
Peter Steinberger and OpenClaw contributors at upstream revision
`3195fba90643c3897c538f2f6891c405331bee9c`. Its value criteria and campaign
preservation review apply alongside Agentify's charter. GPT-6.1 Sol subagents
used medium for reconciliation, high for bounded remediation and review, and
xhigh for broad planning and preservation analysis. Work was divided by
production owner; shared files and mutations were serialized.

## Repairs and retained proof

The bootstrap command records a signed attempt before awaiting its response.
A lost signed exchange or unreadable body without a settlement receipt now
reports an unknown outcome instead of claiming that nothing was charged. A
readable receipt retains precedence even when the response body is lost.
Actual loopback HTTP socket failures, unsigned negative controls, receipt
variants and a separate intercepted-fetch reproduction establish this boundary.
The [original reproduction](test-audit-2026-10-27/bootstrap-loss.mjs) and
[baseline output](test-audit-2026-10-27/bootstrap-loss.json) remain historical
failure evidence; they are not the candidate's result.

The five originally surviving audit mutations now have stronger primary
keepers: payment RPC requests distinguish the actual token, wallet and nonce;
WooCommerce transport proves the native TLS server name and HTTP Host;
asynchronous analytics cannot complete before delivery or lose a rejected
retry; the scanner entrypoint must execute its child and propagate arguments
and exit status; documentation delimiters must exist before their ordering is
compared. The original [mutation evidence](test-audit-2026-10-27/evidence.json)
continues to describe the baseline, not a current mutation score.

Other repairs exercise actual HTTP refusals, independent payout bytes, persisted
receipts and goods, database rollback and leases, real queue transitions,
request deadlines, accessible browser controls and loaded styles. Scanner
checks distinguish incomplete evidence from a negative result and preserve
scoring denominators. Stronger controls also exposed and repaired fragment
validation after URL normalization, IPv6 evidence leakage, mutable actor-build
pins and a duplicate raw-HTML parser's entity and dormant-content mistakes.
The actor now uses the existing production tokenizer.

Consolidation removes ten test files, including gallery inventories, the
higher-level Woo request wrapper, recorded-split duplicates, bare site chrome,
the registration wrapper, evidence-helper tests and source/token inventories.
Their independent consumer contracts live in transport, HTTP, database,
browser, published-schema and actual command keepers. Necessary boundaries
remain separate even when they use similar input. Test-only store methods,
configuration hooks, exports, injection properties and duplicate parser code
are removed with the tests that required them.

Independent preservation reviews cover every actionable subject across the
bootstrap, contracts/SDK, gateway/storage, payments, dashboard and scanner/web
owners. Reviewers found lost or unreachable assertions, including whitespace
refusals, authenticated replay privacy, a missing diagnostic, the secure-URL
warning contrast, long-rule cost accounting, native submit controls and
first-control skip navigation and client-ID redaction in preflight diagnostics. Each accepted gap was restored and checked with
a production mutation before source restoration. Review records retain the
finding and its resolution; no preservation finding remains open. Targeted
controls include invalid and retargeted attempts in their evidence, rather
than counting every failing run as a killed mutation.

## Size and validation

Physical line counts use the same test-file classifier as the original
inventory. Test-support classification is reconstructed explicitly in external
`remediation/final-metrics.json`; production is counted separately.

| Surface | Original audit | Integrated main before campaign | Candidate |
| --- | ---: | ---: | ---: |
| Test files | 424 | 424 | 416 |
| Test lines | 150,942 | 151,497 | 148,933 |
| Test-support lines | 13,128 | 13,388 | 13,221 |
| Production lines | 145,696 | 146,355 | 146,010 |

Relative to integrated main, tests shrink by 2,564 lines, support by 167 and
production by 345. Assertions added to repair weak proof count against these
savings. New main changes explain why comparisons with the original audit
differ. The final collected and executed total is 7,700 cases, compared with
8,445 originally collected; this includes new main regressions and is not a
count of assertions deleted.

Validation used Node 24.22.1 and pnpm 11.12.0. Final source remained fixed during
all checks. PostgreSQL used a disposable loopback container and separate
explicit test databases. Browser and transport probes used local fixtures.

| Command or lane | Result |
| --- | --- |
| `vitest run --project unit --maxWorkers=4` | 6,625 passed in 371 files |
| `pnpm scanner:ops:test` | 9 passed |
| `pnpm test:db` | 576 passed in 27 files |
| `vitest run --project integration --maxWorkers=1` | 328 passed in 11 files |
| Python discovery in `deploy` and `deploy/ansible` | 148 + 14 passed |
| `pnpm build`, `pnpm typecheck`, `pnpm check`, `pnpm deadcode` | Passed |
| Decision log, retired claims, scanner migration consistency, three asset budgets | Passed |
| `pnpm gallery` and `pnpm gallery:check` | 329 states at four widths; no gate failures |
| `pnpm scanner:self-readiness` | Passed local gate; score 93, coverage 1; MCP check 9 fails |

An earlier concurrent run exceeded the stand process-start and parser-duration
limits. The complete offline lane then passed with four workers without
concurrent build/database jobs; its assertions and time thresholds were not
weakened. Logs retain both attempts. Biome reports 12 existing warnings and an
informational diagnostic; the gallery reports moderate/minor accessibility
observations below its failure threshold. Those results are not a claim that
every UI concern is resolved.

CI also exposed two clean-build dependencies that local generated output hid.
The standalone documentation image now installs the SDK dependency closure
needed by its direct SDK-source imports. Its actual Linux image build fails
before the repair and passes afterward, with generated documentation checked
in a network-disabled container. The gateway runner uses observability's
existing source export, consistently with the other gateway/app entry points;
all five affected command tests fail with compiled observability absent before
the repair and pass afterward. These follow-ups leave assertions intact.

No live payment, facilitator, merchant API, release or deployment was performed.
Native request-option proof is not a live TLS handshake. Targeted mutations
are not an exhaustive mutation score. This campaign establishes the recorded
regression checks and preservation decisions, not product acceptance or the
absence of undiscovered defects. CI and the charter's two PR reviews remain
separate acceptance gates.
