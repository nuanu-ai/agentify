# Mutation kill matrix: a trial against the October test audit

## The question

Can mutation testing tell a useless test from a useful one where syntax cannot?
On 2026-10-27 an audit read every test case of commit
`77a9b578312e696826f378405c099f4996bcd703` and gave 1,131 declarations, 18.5% of
them, a verdict other than "retain": repair, consolidate or delete. A syntactic
check over the same commit reached 17 of those 1,131. The audit's own reasons
explain why. The largest are duplication (377), English wording pinned by a test
(209), weak oracles (178), tests of test machinery (127), names that promise more
than the test checks (104) and fakes that supply the behaviour being asserted
(71). None of these shows in a test's syntax, but several may show in which
mutants of production code a test kills.

## Method

The trial runs Stryker over one package of the audited commit. Every test that
covers a mutant runs against it (`disableBail`), so the report names every test
that kills each mutant, not only the first. String-literal mutants are included
and static mutants stay excluded, as in today's configuration. At most four test
processes run at once, on the author's laptop.

The run gives, for each test, the set of mutants it kills, and from that three
signals. A test is flagged when it kills nothing; when every mutant it kills is a
string-literal mutant; or when it kills something and one other test kills
everything it kills. Of two tests that kill exactly the same set, the one
declared later is flagged.

The package is chosen by a rule fixed here. Among packages whose tests run in the
unit project, it is the one with the most audit verdicts other than "retain"
whose reason is duplication, pinned wording, test machinery or fakes supplying
behaviour; a tie goes to the package on the purchase path. If Stryker's dry run
estimates more than three hours, the next package by the same rule is taken.

Each flagged test is compared with the audit's verdict for its declaration,
matched by file and line. Where the audit retained a flagged test, ten such tests
are read by hand to say whether the run or the audit is right.

## Predictions

These are fixed before the run.

- P1, precision: at least half of the tests flagged by any signal carry an audit
  verdict other than "retain", against a base rate of 18.5%.
- P2, recall: at least half of the package's audit verdicts other than "retain"
  whose reason is duplication, pinned wording, test machinery or fakes supplying
  behaviour are flagged by a signal.
- P3, false refusals: at most one in ten tests the audit retained kills nothing.
- P4, cost: the run takes at most ninety minutes of wall time.

## Decision rule

If P1, P2 and P3 hold, the kill matrix becomes the signal for new tests: a
command run at hand-over over the changed files lists the new tests the three
signals flag, and existing tests are swept package by package, with the flags as
candidates for the test-audit review rather than verdicts. If P3 fails, "kills
nothing" is a list for review and not a gate. If P1 or P2 fails, the kill matrix
does not find what the audit found, and mutation testing stays a list of
surviving mutants for review. P4 decides only where the command runs, at
hand-over or overnight, and not whether it runs.

## Results

The trial ran on 2026-10-31 against a detached checkout of the audited commit,
with the options the method names: every covering test ran against each
mutant, string-literal mutants were included, static mutants were excluded and
four test processes ran at once. The laptop was shared with other work the
whole time, at a one-minute load average between about four and twenty-two.

### The package

The audit's reason field is free text, so the four categories of the rule are
regular expressions over it, fixed before any mutant ran. Duplication matches
duplicate, repeat, subset, subsumed, redundant, overlap, replay, "already
asserted" or "already proven", "no independent assertion", "same ... as", and
the consolidation instructions ("carry ... into", "fold into", "merge into",
"move ... into", consolidate). Pinned wording matches prose, wording, English,
sentence, phrase, copy, and "pins the text", label, heading or message. Test
machinery matches machinery, harness, helper, self-test, test double,
test-only, seam, inventory, and fixture or gallery metadata. Fakes supplying
behaviour match fake, fabricated, mock, stub, synthetic, scripted, invented and
stand-in. Over the audit's 1,131 non-retain verdicts these find 422
duplication, 208 pinned wording, 140 test machinery and 69 fakes, 731
verdicts in at least one category, against 377, 209, 127 and 71 in the
question above, which classified the same field differently. Beyond the four
categories, the reasons mostly speak of weak oracles ("only checks",
"nonempty", "passes even if"), names that promise more than the test checks,
coupling to an implementation (call counts, CSS markup, internal thresholds),
wall-clock budgets, and seams that exist in production code only for tests,
such as an injected clock.

Five packages rank above the one that ran, and Stryker estimated more than
three hours for each. Stryker prints no estimate from a dry run alone, so the
estimate taken is its own remaining-time figure about four minutes into mutant
testing, straight after the dry run. Gateway, dashboard, contracts and core
are mutated against the offline suite, 7,222 tests, so a mutant in shared code
runs hundreds of tests; web and scanner run only their own.

| Package | Verdicts in the four categories | Mutants | Dry run | Stryker's estimate |
| --- | ---: | ---: | ---: | --- |
| `apps/gateway` | 285 | 22,765 | 6 min 54 s | 34 to 40 hours |
| `apps/dashboard` | 170 | 25,992 | 6 min 8 s | about 34 hours |
| `packages/contracts` | 68 | 1,738 | 6 min 15 s | 9 to 11 hours |
| `apps/web` | 60 | 11,393 | 1 min 20 s | 9 to 10 hours |
| `packages/core` | 56 | 1,619 | 6 min 47 s | about 5 hours |
| `packages/scanner` | 26 | 5,344 | 9 s | about 50 minutes |

Four adjustments got the dry runs through. The whole suite outlasts Stryker's
default five-minute limit for a dry run, which was raised to an hour. Two slice
test files, `stand.test.ts` and `additions-command.test.ts`, cannot start pnpm
inside Stryker's sandbox and were left out of the whole-suite pool. Babel, which
Stryker parses with, rejects `ad-reports.ts` and `nuanu-analytics.ts` in the
dashboard, so the dashboard attempt left those two files unmutated. Twelve
scanner tests require a megabyte input to be parsed within 500 ms and fail
under Stryker's instrumentation every time; they were skipped in the run and
are outside the population below. Ten of them carry "retain" and two carry
"repair".

### The run

Stryker mutated `packages/scanner` into 5,344 mutants. It ignored 365 as
static and tested 4,979: 3,141 were killed, 1,341 survived, 383 had no covering
test and 114 timed out. Of the 1,091 string-literal mutants, 464 were killed.
The dry run took 9 seconds and mutant testing 51 minutes 51 seconds. The
seventy minutes before that run went to finding a package that fits the
budget, almost all of them in dry runs and in the first minutes of runs that
were stopped.

Stryker's vitest runner reports a test by its file and full name, without a
line. Each test was matched to the audit's case record with the same file and
full name, and the case record names its declaration by file and line. All 349
tests that ran matched, to 197 declarations, and none was left unmatched. An
`it.each` row is a test of its own both for Stryker and in the audit's case
records, and every row maps to the one declaration of its table: 36
parameterized declarations hold 188 of the 349 tests. Vitest's own listing with
locations gives the declaration's line for 213 tests; for the other 136 the
audit gives the line where `it.each([` opens and vitest the line where the
test's name is passed, and the case records connect the two.

### Predictions

| Prediction | Fixed beforehand | Result | Outcome |
| --- | --- | --- | --- |
| P1, precision | at least half of flagged tests not "retain" | 2 of 104, 1.9% | failed |
| P2, recall | at least half of 26 verdicts flagged | 2 of 26, 7.7% | failed |
| P3, false refusals | at most one in ten retained tests kills nothing | 0 of 313 | held |
| P4, cost | at most ninety minutes | 51 min 51 s | held |

The signals flag 104 of the 349 tests, every one of them by the third signal:
no test kills nothing, and no test kills only string-literal mutants. Two of
the 104 carry a verdict other than "retain", against 36 of the 349 tests in the
package (10.3%) and 18.5% across the audit's register, so a flagged test is
less likely than an unflagged one to be among the audit's findings. Of the 104,
66 are rows of an `it.each` table whose kills another row of the same table
covers, and 33 are covered by another test in the same file.

The two verdicts P2 finds are a delete candidate at `engine.test.ts:1206`,
whose reason says it repeats a suppression another test proves more sharply
and which the run finds covered by a test killing 49 mutants to its 18, and a
repair at `parsers.test.ts:541`. Read one by one, four of the 26 reasons match
a pattern by accident: in three, a form of "repeat" describes an input or a
repeatable measurement, and the "sentence" of `parsers.test.ts:541` is text
fed to the price reader, whose complaint is a weak oracle. Without those four
the run flags 1 of 22. Two of the 26 belong to the skipped timing tests; of the
24 whose tests ran, the run flags the same 2. By category it flags 1 of 16 for
duplication and 1 of 13 for pinned wording; no reason in this package falls
under test machinery or fakes.

Every test kills at least one mutant, so P3 holds with room; the fewest any
test kills is one. P4 holds at 51 minutes 51 seconds, for a package of 361
tests that each run in milliseconds.

### Ten flagged tests the audit retained

The run flags 102 tests the audit retained, in 36 declarations. Ten were drawn
at random, at most one per declaration, and read with the mutants they and
their covering test kill.

| Test | Who is right | Why |
| --- | --- | --- |
| `engine.test.ts:1140`, score 50 is `callable_ready` | audit | Row 50 holds the lower edge of the band: were the constant 49 to become 50, row 50 would fail and the covering row 69 would pass. Stryker never mutates a number, so the run cannot see the difference. |
| `ip.test.ts:6`, 169.254.169.254 is blocked | audit | The link-local block, home of the cloud metadata address, is a row of a table built at load, and static mutants are excluded. |
| `ip.test.ts:72`, 2001:30::1 is refused | audit | It pins refusing the IETF protocol block whole, its reachable drone-identifier range included; the table is static and one entry serves every row. |
| `ip.test.ts:102`, `http://localhost/` is rejected | run | Both the blocked-suffix pattern and the single-label rule stop it, and other rows of the same table (`https://shop/`, `https://shop.localhost./`) pin each rule. |
| `parsers.test.ts:83`, user agent `agentify-scanner/1.0` | audit | It proves a version after the product token is ignored. No mutant turns token matching into whole-value matching, so its kills equal the plain row's. |
| `parsers.test.ts:93`, a group naming only `agent` | run | The `agentify` row of the same table already fails any prefix match, and `agent` catches nothing more. |
| `parsers.test.ts:612`, padded Content-Signal decided in time | audit | Its promise is a time bound against hostile input. Mutants change what the parser answers, never what the answer costs. |
| `parsers.test.ts:762`, a style the page is cut inside | audit | Style is read as raw text through a set built at load; removing it from the set breaks this row and not the script row that covers it. |
| `engine.test.ts:1236`, `Vary: Accept-Encoding` is not Accept | audit | It holds whole-element matching of the header against substring matching, a change no mutation operator makes. |
| `engine.test.ts:1447`, a 429 leaves a document unjudged | audit | 429 is one member of a static set of statuses read as unread, and only its own row protects it. |

The audit is right in eight of the ten and the run in two. In the eight, the
promise sits where the run's mutants do not reach: in tables built at load,
which static exclusion leaves alone; in number literals, which Stryker does not
mutate; in a kind of wrong implementation no mutation operator produces; or in
the time a parse takes.

### The decision

P1 and P2 failed, so in the decision rule's words the kill matrix does not find
what the audit found, and mutation testing stays a list of surviving mutants
for review. P3 held, so the rule's clause for a failed P3 does not apply, and
"kills nothing" never fires on this package. P4 held, but it decides only where
an adopted command runs, and no command is adopted. The sample is one package
with 26 target verdicts, because the five packages holding most of the audit's
findings did not fit the three-hour budget. On the scanner, subsumption between
kill sets mostly finds table rows and specification cases that the audit kept
for reasons mutants cannot represent.

### Beyond the predictions

Alone, "kills nothing" and "kills only string literals" flag no test, and
every flag comes from the third signal: 104 tests, precision 1.9%, recall 2 of
26 for the four categories and 2 of 37 for every non-retain verdict in the
package. Taking the declaration as the unit, with its rows' kills merged, gives
17 flagged declarations of 197, two of them non-retain (11.8% against the
package's 17.8%), and leaves P2 at 2 of 26.

The fallback the decision rule names is the list of surviving mutants. The
scanner has 1,724 of them among 4,979 tested: 1,341 that survived and 383 with
no covering test. Of these, 452 are string-literal mutants. `checks.ts` holds
748, `html.ts` and `parsers.ts` 224 each, `ip.ts` 122 and `url.ts` 103.
