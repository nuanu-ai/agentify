# Cabinet navigation campaign

All 48 browser traces pass: 576 logical operations complete, with no failing
or skipped trace. The lead executes the suite in 75,216 ms against the built
dashboard pages and local in-memory identity/gateway services. No external
authentication, mail provider, merchant API or payment network is used.

The subject is `e11fef741e875ef6f9c42465a6b27577dd2921a1`. This is the interface
matrix of the [registered campaign](plan.md), refined with the lead before
execution into an observable twelve-operation skeleton. The reusable source is
[navigation-campaign.integration.test.ts](../../../apps/dashboard/src/navigation-campaign.integration.test.ts),
and the [sanitized seed and case ledger](navigation-evidence.json) records
each executed seed, viewport, account position and navigation targets.

The three frozen base seeds, `0xC61A0001`, `0xC61A0002` and `0xC61A0003`, each
derive sixteen trace seeds using
`uint32(base XOR imul(trace + 1, 0x9e3779b9))`. All 48 derived seeds are unique.
There are 24 desktop traces at 1280×900 and 24 mobile traces at 390×800 with
touch support. Every trace creates two local merchant accounts and a uniquely
identified card derived from the lab's Gift Message Templates product. The
initial actor, navigation targets, initial selling state and changed seller
name depend on the seed.

Each trace performs these twelve logical operations. Navigation needed to
reach a control is part of its operation; the count is not a count of browser
clicks or requests.

1. Navigate through the dashboard's section link to a seeded target.
2. Focus another section link as prefetch intent, then navigate to it.
3. Submit the selling form and compare the completed state with the real gateway.
4. Reload Cards and compare its owner, card identity and selling control with persisted state.
5. Change the seller name through the real whole-document form and read it back.
6. Go Back and check ownership plus the persisted state observable on that screen.
7. Select Open Orders and check the settled address and selected filter.
8. Hold the first Receipts data response at an explicit server barrier, navigate to Orders, then release the old response and check the selected page remains Orders.
9. Replace the session cookie with the other local account's session, submit the old Cards form, and check the refusal names the current account while both merchants' persisted state remains unchanged.
10. Reload and check the new account's own card and form owner marks.
11. Sign out in a second tab, reload the original tab, and check it reaches sign-in without a merchant form mark.
12. Restore the original local session and check that account's completed changes are still visible and persisted.

The oracle reads visible account identity, the form's account mark, card
identity and the real gateway's seller/selling state. On mobile it opens the
actual header menu to read the visible account. The stale-form operation
compares both merchants before and after the rejected submission. A delayed
response is controlled by promises, so a timeout is a harness failure rather
than evidence that a timing guess reproduced a product race. Cleanup releases
the barrier and closes the browser context even if a trace fails.

The lead first executes two desktop/mobile pilot traces and then all 48. The
pilot rerun is not added to coverage. The complete run is:

```sh
pnpm exec vitest run --project integration \
  apps/dashboard/src/navigation-campaign.integration.test.ts \
  --maxWorkers=1 --no-file-parallelism --reporter=json \
  --outputFile=/private/tmp/agentify-navigation-campaign-root.json
```

No new product defect is observed by these traces. They exercise seed-selected
parameters on one fixed skeleton, not every event ordering. Prefetch intent is
invoked, but request counts and cache-hit behavior are not measured by this
suite; the separate existing Chromium suite owns those checks. Cookie
replacement models a login completed in another tab, and does not test a real
provider's login flow. The ledger preserves per-trace verdicts and the asserted
postconditions; it contains no per-step DOM transcript or screenshot.
