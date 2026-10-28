# Unpaid price handover checks, 27 October 2026

Scope: [PR #215](https://github.com/nuanu-ai/agentify/pull/215), branch
`agent/report-followups`, based on `main` at
`b6382b271b7155566ff44ad61ccb872bfbb72d95`. The source implements the
[agreed design](90-unpaid-price-questions-design.md). These local results do
not establish deployment, production readiness or full product acceptance.
Node 24.22.1 and pnpm 11.12.0 were used; Vitest ran with `--maxWorkers=2`.

## Behavior checked

The HTTP owner checks that free pricing and discovery create no durable order,
that forged or expired prices fail before payment execution, and that a timely
payment survives slow verification. It checks concurrent single consumption,
stable buyer keys, invalid-signature non-consumption, binding of parameters and
parcel locality, first verified address ownership, changed cards and payees,
and recovery from the saved offer. Actual purchase headers, including a
512-character escaped merchant reference, fit the existing 8,192-byte boundary;
the ordinary widest parcel probe measured 8,072 bytes.

The shared store contract runs in memory and on PostgreSQL. The real database
checks order/queue transactions, integration locking, receipt rollback,
JSONB round trips, retention and deletion of address-bearing jobs. Fifty-one
unpaid fixed prices leave zero orders and reminder jobs. Price questions write
zero pg-boss jobs; ready durable work precedes in-memory questions.

WooCommerce checks cover product/settings cache lifetimes, fresh paid reads,
reference conversion, separate concurrent destinations, cleanup after
cancellation, quarantine after uncertain mutations, HTTP response/body errors,
clean-cart renewal at a declared expiry and shutdown draining. An empty read
cannot revive a cart whose write outcome is unknown. These are deterministic
transport/lifecycle checks, not a shop capacity benchmark.

## Red and green evidence

The initial whole unit run found caller and fixture assumptions that still
created a durable order at free pricing. They were migrated to actual admitted
payment attempts or completed sales. The second whole unit run passed 6,692 of
6,693 tests across 376 files; the remaining failure expected an old wording of
an otherwise successful recovery refusal. Its state, privacy and one-charge
assertions passed. The wording assertion was corrected to recognize “this
request charged nothing”; both affected owners then passed all 31 tests.

The whole PostgreSQL run passed 521 and failed 50 tests across 27 files. Three
owners needed updates: a deleted Woo quote-table cleanup query, duplicate birth
now returning `exists`, and fixtures that expected a row after free pricing.
The repaired three-owner run passed 202 of 204 tests. Its two remaining failures
counted a duplicate handover newly introduced by using a genuine completed sale
as setup. That duplicate setup was removed; all 157 tests of the PostgreSQL
adapter owner then passed. Assertions for locking, rollback and address cleanup
remain. No database production change was needed for these fixture failures.

Focused commands are:

```sh
pnpm exec vitest run --project unit apps/gateway/src/app/payment-recovery.test.ts apps/gateway/src/http/merchant-price-gate.test.ts --maxWorkers=2
pnpm exec vitest run --config vitest.db.config.ts --maxWorkers=2
pnpm exec vitest run --config vitest.db.config.ts apps/gateway/src/adapters/postgres/adapters.db-test.ts apps/gateway/src/adapters/postgres/order-analytics.db-test.ts apps/dashboard/src/woo-shops.db-test.ts --maxWorkers=2
```

Database commands used this task's disposable PostgreSQL 17 container, with
only local test databases and no deployment credentials. The offline operations
suite passed all nine checks. Final static, build and CI results are recorded
below when their runs complete.

Additional red controls covered cart cache lifetime, declared expiry renewal,
cancellation while a mutation was in flight, shutdown before cleanup, uncertain
proxy responses, HTTP 202 with an apparently valid cart body, and canonical JSON
with omitted optional object properties. The cache/runtime red baseline failed
because the owner class did not yet exist; it is not presented as a pre-existing
behavioral regression. Later controls failed at the intended lifecycle guard.

## Mutation self-check

Each mutation was predicted before execution, applied alone and followed by a
targeted existing consumer test. No other source edits or test commands ran in
that window. All 19 final mutations were killed by failed assertions, with no
survivors, timeouts or unapplied mutations. The runner restored every changed
source file byte for byte.

| Mutation | Promise whose test failed |
| --- | --- |
| Accept a stamp without checking its MAC | A buyer cannot alter the amount or merchant reference. |
| Expire a payment admitted within the price term | Slow verification cannot invalidate timely admission. |
| Omit the first verified full address | Verified ownership freezes the priced parcel address. |
| Overwrite an existing order at birth | One price retains one order and its original buyer key. |
| Skip integration check at first ownership | An old integration cannot accept after a switch. |
| Borrow a busy cart | Concurrent destinations use separate carts. |
| Revive a cart after an uncertain write | A late mutation cannot contaminate another quote. |
| Abort a started mutation with its quote caller | The mutation retains its own budget and slot through cleanup. |
| Return from stop without draining carts | Worker shutdown waits for outstanding cleanup. |
| Reverse the clean-cart expiry condition | A known empty expired cart can renew safely. |
| Extend the product cache to the settings lifetime | A failed short-term refresh cannot serve a stale price. |
| Admit five simultaneous questions | The fifth question is refused at the merchant gate. |
| Admit seventeen questions in one second | Fast answers do not bypass the arrival bound. |
| Put memory questions ahead of paid work | Ready accepted work precedes price questions. |
| Put in-memory questions ahead of durable work | A real PostgreSQL draw gives accepted work priority. |
| Persist free price questions in pg-boss | Unpaid questions leave no durable jobs. |
| Keep a question after its buyer stops waiting | A later poll cannot draw abandoned price work. |
| Retain a forgotten ready question | Forget removes that question without dropping its neighbours. |
| Replay questions after queue restart | A restart cannot revive a departed caller's question. |

An earlier priority mutation survived because the initial database test filled
its batch with both classes of work. The proof was strengthened to draw one
item; the mutation was then killed. The final architecture selects durable
work before transient questions and removes the obsolete pg-boss priority
weights. The final matrix tests that actual selection rule.

The transient gateway-question check also draws directly from the real queue,
so a later HTTP filter cannot mask failure to remove the abandoned question.
Rollback tests have an explicit successful-write control. A standalone script
outside Vitest imported the actual stamp codec and compared its MAC with an
independent Node crypto calculation; authenticated round trip, cross-channel
refusal and stable identifier checks passed with no network or spending.

## Bounded shop probe and remaining limits

A pre-registered 22-request probe on `https://woo.nuanu.ai` used its real Nuanu
Tote Bag (product 23). It took 31.366 seconds, spent nothing, created no checkout
or shop order, and changed no shop configuration. The original Store API token
worked for Bali, Jakarta, a German destination without rates, then Bali again.
Each successful removal left the cart empty. Full locality replacement required
clearing the previous state. Rotating JWT values retained one user identity;
the tokens declared a 172800-second lifetime. Raw local evidence uses hashes,
not token values.

This does not prove actual forty-eight-hour expiry, server-side session count
or deletion, sustainable request rate, bot-protection tolerance or fairness
under sustained load. Four cart slots bound one running shop runtime. Restarts
and renewals may leave older Woo sessions; all four uncertain slots can exhaust
the pool and require a lifecycle intervention. The implementation refuses safely
instead of opening unbounded replacements.

Per-merchant gates and queue selection do not isolate the shared database pool
or facilitator account. No wallet quota or reserved SDK execution slot was
added. TEST purchase/recovery, chain outcomes and final deployed build identity
remain unverified for this PR until the shared-channel check is approved and
completed.

## Independent review and delivery

Separate agents cross-reviewed core admission/address/recovery and WooCommerce
lifecycle code they did not author. Reviews exposed the unverified-body oracle,
uncertain proxy/partial responses, and cleanup ownership hazards during
implementation; the final cross-owner reviews found no further actionable
blocker. This is bounded technical review, with the limitations above.

The full workspace type check, Biome (no errors), Knip, decision-log and
retired-claim checks pass. The complete `pnpm build` passes, including portal
render verification of all seven included examples/programs. Portal and
dashboard browser-script budgets pass. Deployment tests pass 148/148 and
Ansible tests 14/14. Removing the unused Lapsed listing adapter leaves its
22/22 listing tests passing. Final CI and TEST evidence remain pending.

PR #215 is the delivery artifact. Production activation and npm publication
are separate actions.
