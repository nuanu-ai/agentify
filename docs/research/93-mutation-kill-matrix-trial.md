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

Recorded after the run.
