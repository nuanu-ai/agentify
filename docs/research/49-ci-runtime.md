# CI runtime measurements

The changes aim to reduce waiting for CI while keeping every check. Measure each
step separately before attributing a speedup to it. Each step is a separate
commit, so the gallery change and the job split can be measured independently.

## Control observed on 2026-10-15

[Run 38753942942](https://github.com/nuanu-ai/agentify/actions/runs/38753942942)
checks `1c8ab4e8afb2b5950b49b3bf9d4296dd4643859e` on a push to `main`.
Every job passed. Times below come from GitHub's job and step timestamps.

| Measurement | Seconds |
| --- | ---: |
| Workflow creation to last job completion | 465 |
| Workflow creation to first job start | 3 |
| Gate start to completion | 448 |
| Gallery build inside the gate | 16 |
| Biome, typecheck, deadcode, and ordinary tests, combined | 213 |
| Browser job start to completion | 256 |
| Screens job start to completion | 124 |

## Predictions and comparison procedure

Step 1 is `9e44ab57483faa3b9c3a64d695da70e5ce71bf53`: remove the
gate's gallery build while keeping the build and checks in `screens`.
The prediction is 10–20 seconds less work in the gate.

Step 2 moves Biome, typecheck, deadcode, and ordinary tests into `checks`,
beside the database and build job. Both depend on the secret scan. Database
suites remain sequential on their own server. The prediction for the full
workflow is roughly 4–5 minutes without a queue, using the observed step
times and allowing for another checkout and install. This is a scheduling
estimate; it does not measure runner variability or the cost of cold caches.

Pin the control and both candidate commits before dispatching measurements.
Use the same `workflow_dispatch` event for each, with a temporary branch per
commit so their concurrency groups do not serialize the comparison. Run
each variant once initially and record its SHA, run ID, all job and step
durations, time before the first job starts, and total elapsed time. The push
run above is an initial reference, not a substitute for a matched control.

Accept a step only when every job passes and all checks remain present.
Report observed elapsed-time differences separately from removed work.
For the gallery change, if common-step variation exceeds the removed build's
duration, call the elapsed-time result inconclusive. One sample per variant
cannot establish a statistically reliable speedup; repeat only if the result
is ambiguous. Remove the temporary measurement branches when done.

## Measurement status

Both candidates still need GitHub execution. HTTPS requests to GitHub timed
out during preparation. No measured speedup is claimed.

Local validation preserves every command, its environment, the database
configuration, and the secret-scan dependencies. Independent review found no
dependency on output from the moved commands. `git diff --check` and the
decision checks pass. Actionlint reports the same nine existing diagnostics
about numeric service-port keys, with no new diagnostics.
