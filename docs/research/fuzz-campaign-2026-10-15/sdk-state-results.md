# SDK and order lifecycle results

The subject is `e11fef741e875ef6f9c42465a6b27577dd2921a1`; the plan is frozen
in commit `f1ca8e19`. The completed bounded suites find no product defect in
the order core or ordinary SDK response handling. They do not establish that
every input, schedule, payment provider or external integration works.
Product source remains unchanged. The sanitized case ledger is
[sdk-state-evidence.json](sdk-state-evidence.json).

## Executed coverage

| Suite | Actual work | Result |
| --- | --- | --- |
| Generated core lifecycle | 512 traces, 128 attempted steps each: 65,536 steps; 13,624 accepted, 51,912 refused | Passed; all 16 states observed |
| Generation candidates | 1,835,008 transition evaluations used to select events | Exploration overhead, not additional trace steps |
| Critical schedules | Six triplets, six permutations, three time positions: 108 cases | Passed, with explicit checkpoint and final state/payment/outcome expectations |
| Complete SDK responses | Six routes, ten response classes, six valid input representatives: 360 cases | Passed; one HTTP call per invocation and no I/O from answer builders |
| Worker lifecycle | 24 stops inside handlers, eight stops during answers, one parked poll, one restart: 34 cases | Passed; actual subjects, answer counts, problems and unread work checked |

The core tests are in
[state-campaign.test.ts](../../../packages/core/src/orders/state-campaign.test.ts).
Their independent ledger counts outstanding charge requests, goods, receipts
and address erasures; it also checks that settled money has goods or a debt
and that an unknown result remains described as unknown. The production
`moneyInvariantViolations` check supplements that ledger. Deterministic replay
and input preservation are checked on every chosen step. Seeds and per-case
identifiers are saved in the evidence, using the plan's seed formula.

The generated traces reach 367 charge effects, 237 goods releases, 237 receipts,
155 recorded debts and 128 address erasures. These are descriptions emitted by
the pure state machine, not executed payments or deliveries. Evidence separates
those trace counts from the larger counts that include schedule setup paths.
State visit counts include repeated observations of a state. Generator time
class counts describe selected classes: a proposed instant earlier than the
preceding event is clamped to preserve time order.

Seventy-two critical schedules use actual armed deadline boundaries at
deadline minus one, deadline and deadline plus one. The other 36 start from
`refund_due` or `delivered_unpaid` without a running deadline; they are labelled
time samples. Event ordering can legitimately change an outcome, such as
delivery racing a recorded refund. The assertions use the expected outcome
for each permutation rather than assuming every permutation commutes.

The SDK checks are in
[response-campaign.test.ts](../../../packages/sdk/src/response-campaign.test.ts).
They run the public client and real worker against the existing loopback fake
gateway. They cover success and refusal values, thrown `AgentifyError` values,
preserved codes/retry advice/identifiers, malformed complete responses, and
body parsing independent of HTTP status. Worker cases assert that stopping
ceases polling, leaves suffix messages undispatched, reports an abandoned
answer by its subject, shares concurrent stop completion and retains handlers
on restart. An event callback's return value creates no acknowledgement.

## Scope accounting and limitations

The original connection-loss cells before headers and during the body are not
executed: 72 planned cells. Before the narrowed run, 72 replacement cells were
registered for complete responses containing truncated JSON and 429 error
envelopes. Thus 288 original response cells and 72 extension cells run; the
replacement cases do not prove transport-loss behavior or `outcome_unknown`
classification on a real broken exchange.

The worker plan allows up to 144 cases. This suite runs 34 distinct schedules.
Events have no answer route, and throwing or invalid order/quote handlers
send no answer, so those answer-phase combinations are inapplicable. A parked
poll has no delivered payload; repeating it for hypothetical handler and batch
choices would repeat the same observation. A handler that never resolves is
not tested as a bounded-stop promise: the documented stop waits for it.

The frozen plan records an earlier service cybersecurity-risk filter and the
resulting scope clarification. These completed suites exercise pure functions
and ordinary consumer handling only. They perform no security probes, provider
calls, wallet operations, database access or external network requests.

The subagent's Vitest process could not bind loopback (`listen EPERM`), including
an unchanged SDK baseline test and a thread-pool probe. Those are environment
failures. The root ran the same ready SDK file successfully and saved its
observations; the environment failures are not counted as product failures.

## Controls and validation

A disposable copy changes the already-delivered arm of `fromDelivered` to emit
goods and receipt effects again. The independent ledger kills the mutation:
`state-sync-none-0`, seed `2133366477`, step 23, `handler_delivered`, reports
goods/receipts issued twice. The unchanged subject passes the same ledger.
The mutation changes no order fields, so the production order invariant check
alone would not catch this duplicate effect. The shared `machine.ts` bytes
still match the subject commit. The mutation patch, source hash and replay
directory are recorded in the evidence.

Commands use one Vitest worker. The core file passes 109 tests in 1.38 seconds
on its first complete run; the root's SDK run passes 394 tests in 0.628 seconds.
Both remain inside the initial suite budgets. Package core and SDK TypeScript
checks pass, and Biome passes for the two added test files. No existing product
files are edited and no changes are committed by this work package.

```sh
AGENTIFY_STATE_CAMPAIGN_EVIDENCE=/private/tmp/agentify-state-campaign.json \
  pnpm exec vitest run --project unit --maxWorkers 1 \
  packages/core/src/orders/state-campaign.test.ts
AGENTIFY_SDK_CAMPAIGN_EVIDENCE=/private/tmp/agentify-sdk-campaign.json \
  pnpm exec vitest run --project unit --maxWorkers 1 \
  packages/sdk/src/response-campaign.test.ts
```
