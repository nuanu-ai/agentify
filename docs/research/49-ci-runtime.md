# CI runtime measurements

> Historical, 2026-10-15. The measurements behind the jobs of `.github/workflows/ci.yml` on that day; the jobs have changed since.

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

Step 2 is `ef9aa7633a26120f052ecc03dae2baa52c84d8c1`. It moves
Biome, typecheck, deadcode, and ordinary tests into `checks`,
beside the database and build job. Both depend on the secret scan. Database
suites remain sequential on their own server. The prediction for the full
workflow is roughly 4–5 minutes without a queue, using the observed step
times and allowing for another checkout and install. This is a scheduling
estimate; it does not measure runner variability or the cost of cold caches.

Pin the control and both candidate commits before dispatching measurements.
Use the same `workflow_dispatch` event for each, with a temporary tag per
commit so their concurrency groups do not serialize the comparison. The
`ci-bench-*` tags match no automatic workflow or deployment trigger. Run
each variant once initially and record its SHA, run ID, all job and step
durations, time before the first job starts, and total elapsed time. The push
run above is an initial reference, not a substitute for a matched control.

Accept a step only when every job passes and all checks remain present.
Report observed elapsed-time differences separately from removed work.
For the gallery change, if common-step variation exceeds the removed build's
duration, call the elapsed-time result inconclusive. One sample per variant
cannot establish a statistically reliable speedup; repeat only if the result
is ambiguous. Remove the temporary measurement tags when done.

## Matched runs on 2026-10-15

GitHub recovered after the preparation outage. All three variants ran with
`workflow_dispatch` on the pinned commits above; all 19 jobs passed. Each
run waited four seconds from creation to its first job. Temporary measurement
tags were removed after completion.

| Variant | Run | Total elapsed | Gate | Source checks |
| --- | --- | ---: | ---: | ---: |
| Control | [38758324800](https://github.com/nuanu-ai/agentify/actions/runs/38758324800) | 6:01 | 5:44 | Within gate |
| Step 1: gallery once | [38758334996](https://github.com/nuanu-ai/agentify/actions/runs/38758334996) | 7:52 | 7:31 | Within gate |
| Step 2: parallel checks | [38758343928](https://github.com/nuanu-ai/agentify/actions/runs/38758343928) | 4:37 | 3:43 | 4:17 |

Step 1 removes a gallery build that took 13 seconds in the matched control.
Its effect on elapsed time is inconclusive: the run took 111 seconds longer,
and common commands varied by more than the removed work. For example,
ordinary tests took 113 seconds in the control and 157 seconds after step 1;
typecheck took 35 and 50 seconds. The `screens` job built and checked the
gallery successfully in every variant. Removing duplicate work is verified;
a smaller elapsed time from this step alone is not.

Step 2 completed 195 seconds sooner than step 1 and 84 seconds sooner than
the matched control, an observed 23.3% reduction against the control. The
source-check job determined completion. These are single-run observations,
not an estimate of the typical improvement: even unchanged jobs varied.
The earlier 7:45 push run is not used to calculate the improvement.

Other job durations, in seconds:

| Job | Control | Step 1 | Step 2 |
| --- | ---: | ---: | ---: |
| CI secret scan | 10 | 10 | 13 |
| Screens | 134 | 140 | 123 |
| Portal | 28 | 33 | 30 |
| Decisions | 112 | 94 | 99 |
| Browser | 258 | 239 | 216 |

Command durations from the gate and the new source-check job, in seconds.
The run links retain the complete job and step timelines.

| Command | Control | Step 1 | Step 2 |
| --- | ---: | ---: | ---: |
| Install dependencies in gate | 10 | 20 | 15 |
| Install dependencies in checks | Absent | Absent | 14 |
| Biome | 8 | 12 | 13 |
| Typecheck | 35 | 50 | 52 |
| Deadcode | 2 | 3 | 4 |
| Ordinary tests | 113 | 157 | 168 |
| Gallery build in gate | 13 | Removed | Removed |
| Database tests | 88 | 98 | 102 |
| Scanner integration tests | 13 | 19 | 19 |
| Scanner database tests | 10 | 15 | 14 |
| Build applications | 25 | 35 | 35 |
| Dashboard budget | 1 | 1 | 1 |
| Web budget | 1 | 3 | 2 |
| Scanner start test | 3 | 5 | 5 |
| Scanner readiness | 6 | 6 | 6 |
| Scanner admin-door test | 2 | 3 | 3 |

## Local validation

Local validation preserves every command, its environment, the database
configuration, and the secret-scan dependencies. Independent review found no
dependency on output from the moved commands. `git diff --check` and the
decision checks pass. Actionlint reports the same nine existing diagnostics
about numeric service-port keys, with no new diagnostics.

## Follow-up comparison plan

The control for the next two steps is
`5d7d608736c2158a7355ef47263a4fd5b9881692`, whose PR CI and Images runs pass.
The product owner approves both steps, with a separate commit and measurement
for each.

Step 3 moves the unchanged `pnpm test` command into a separate job beside
Biome, typecheck, and deadcode. Both jobs require the secret scan and install
the same dependencies. The prediction is about 34 seconds less elapsed time
if other job durations match the completed step-2 measurement: the database
and build job would then determine completion at roughly four minutes.
Another checkout and install add work even when elapsed time decreases.

Step 4 reuses the web build already produced by `scanner:test:browser` in the
same job. The documentation still builds before its unchanged browser test
file runs. The standalone `docs:test:browser` command continues to build both
applications for callers without an existing build. The prediction is about
13 seconds less work in the browser job; total elapsed time may be unchanged
if another job finishes last.

Measure these pinned commits with the same temporary-tag and
`workflow_dispatch` procedure. All jobs must pass, including the unchanged
offline suite and all browser suites. Record each step's elapsed difference
against its immediate predecessor and compare common-command variation.
If variation exceeds the work removed, report the elapsed-time effect as
inconclusive. Do not combine a reduction in work with a claim of the same
reduction in total waiting time.

## Follow-up matched results

Step 3 is `3e207de2352e5a9bcebe30b53057dfe690988637`; step 4 is
`8b9187d3fa21e770ba1395705c83c97cb28b4f19`. Each is measured with
`workflow_dispatch` on its own temporary tag. All 23 jobs across the three
runs pass. The temporary tags are removed after completion.

| Variant | Run | Total elapsed | Static checks | Offline tests | Gate | Browser |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| Follow-up control | [38761224943](https://github.com/nuanu-ai/agentify/actions/runs/38761224943) | 4:37 | 4:13 including tests | Within checks | 3:46 | 4:20 |
| Step 3: separate offline tests | [38761233306](https://github.com/nuanu-ai/agentify/actions/runs/38761233306) | 4:46 | 1:37 | 3:16 | 4:11 | 4:09 |
| Step 4: reuse the web build | [38762138955](https://github.com/nuanu-ai/agentify/actions/runs/38762138955) | 4:10 | 1:31 | 2:41 | 3:37 | 3:52 |

Step 3 passes all eight jobs, but its total elapsed time increases by nine
seconds in this pair. It does not demonstrate a workflow speedup. The tests
run independently of static checks, leaving the gate and browser jobs to
determine completion. In the control the browser job finishes last; after
step 3 the gate finishes last.

Both runs wait four seconds before their first job. Control jobs start three
seconds after the secret scan finishes. Step 3's tests, static checks, and
browser start after two seconds, while its gate starts after 20 seconds.
The unchanged database-test command also varies from 103 to 130 seconds.
These delays and duration differences matter more to total elapsed time than
the now shorter source-check path.

Step 4's browser job is 17 seconds shorter than step 3's, with its
documentation phase decreasing from 72 to 56 seconds. The same documentation
integration file runs after its own application build, using the web output
already built and tested in the preceding step. The browser job determines
completion in this run.

The full workflow is 36 seconds shorter than step 3 and 27 seconds shorter
than the follow-up control in this sample. Step 4 also has shorter unchanged
jobs: the gate decreases from 251 to 217 seconds and offline tests from 196
to 161 seconds. Its first job starts after four seconds, and subsequent jobs
start three or four seconds after the secret scan. The repeated web build
is removed, but the effect on total elapsed time remains inconclusive under
the predeclared variation rule; the whole 36-second difference cannot be
attributed to that removal.

The browser logs show the same passing counts before and after step 4:
7 actor tests, 32 dashboard tests, 95 web tests, and 57 documentation tests.
The documentation's Vitest execution is effectively unchanged at 49.36 and
49.41 seconds; the shorter phase omits the repeated application build.

Independent static review confirms the new test job preserves the offline
suite and its setup, and that browser suites leave the web build available.
The one-off workflow comparison preserves all unrelated commands and job
settings. Actionlint has no new diagnostics, and decision checks and
`git diff --check` pass.
