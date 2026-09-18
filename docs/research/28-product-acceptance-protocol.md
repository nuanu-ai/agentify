# Agentify Stage 4 TEST product acceptance protocol

**Frozen before execution:** 2026-09-18. The acceptance owner records browser evidence and the final verdict. Operations owns TEST state changes and consolidates required secret references once. The SDK owner runs the external consumer and coordinates replay.

## Claim and boundary

Using an operator-owned merchant at the public boundary, prove the complete current SDK journey: real email sign-in, TEST seller setup, TEST key, published card, handler, operator-started purchase, fulfillment, settlement, goods and receipt. Prove the named authentication and recovery cases without treating this as the first uncontrolled merchant. Stage 4 remains open after this run.

- Initial candidate: TEST commit `f010307dc9d7cc8b4dcbb8c06635173127cd7304`, SDK `0.2.5`, contracts `0.3.2`. Record what is actually deployed and installed.
- Use a new operator-owned alias. If it already belongs to a merchant, record a different unique alias. Preserve existing merchants unchanged.
- TEST only. Each paid attempt is at most `0.01` test USDC; all attempts together are at most `0.05` test USDC; real-money spend is zero. Do not use `pnpm buy` against TEST.
- Do not expose magic links, key or wallet secrets, authorization headers or personal payloads. Record stable catalogue, card, order, settlement and receipt IDs.
- WooCommerce, broad scanning, production promotion and a new buyer or SDK surface are outside this run.
- An authorized source fix changes the candidate: record the failure, deploy the final SHA and rerun the complete affected path on that SHA. Never combine versions into one pass.

Auth work may begin once the candidate and mailbox are known. A missing funded buyer blocks only paid rows. Before the first paid row, operations records the buyer workflow, amount, network and asset, and where settlement and receipt will be observed. The guarded one-item wrapper around `pnpm smoke:bootstrap <item-id> --confirm` sets both `SMOKE_MAX_USD=0.01` and `SMOKE_TOTAL_USD=0.01`; it must refuse mainnet and self-pay. Its durable attempt ledger allows at most five attempts across processes, which enforces the `0.05` aggregate cap. Its exit also judges Coinbase Bazaar listing, so an observed `settled:` transaction and the listing verdict are recorded separately.

The main alias has a limit of three link requests per hour. Use requests one and two for the independent browser sessions and reserve request three for reauthentication after the completed order is server-expired. Use one distinct, declared auth-edge alias for the expired unused link and any earlier session-expiry check. Test rate limiting in isolation; never edit a counter or global TTL.

For controlled expiration, capture a cutoff immediately before requesting the link or session. Operations locks and requires exactly one active row for that alias, purpose and `created_at >= cutoff`, then changes only its expiry and update timestamps to the past. For a session, match through the cabinet account email. Never delete a row, sign out or clear cookies.

## Evidence and UX rubric

Use one label for each observation: **Browser**, **SDK runtime**, **Operator purchase**, **Controlled TEST expiration**, or **Isolated automated failure**. An isolated injected failure proves the recovery rule, not deployed UI.

At every row record `pass`, `partial`, `fail` or `blocked`, plus the candidate SHA. Answer briefly: can a newcomer infer the next action; is known data requested again; does failure explain a safe recovery; is internal jargon exposed; does the promise match the path; are reload, Back and a second tab intelligible; is TEST versus live clear before action; and is empty distinguishable from unavailable, unknown or processing?

Prioritize blocked completion, misleading promise, unsafe ambiguity, then recoverable confusion. Change only the smallest coherent set needed by this SDK path.

## Ordered execution

| # | Action and evidence | Expected outcome |
|---|---|---|
| 0 | Record candidate versions, aliases, UTC start, browser profiles, seller name, consumer directory and evidence table. **Browser / SDK runtime** | One observable candidate and identity exist. Version or identity drift stops only the affected rows. |
| 1 | From a clean browser, cold-read landing, docs, quickstart, TEST/live cues, prerequisites and first-purchase handoff without repository hints. **Browser** | A newcomer finds the SDK path. No public request path exists for a self-signup without an assigned operator: record `USER-DEFERRED` for the contact decision and treat private coordination as evidence only for this run. |
| 2 | Request two links for the main alias before consuming either. Open each confirmation GET, reload and use Back/Forward, then confirm each by POST in a separate browser. Reuse one consumed link and sign out one session. **Browser** | GET/navigation does not consume a link. Both links work independently once for the same merchant. Used link explains recovery. Signing out one session leaves the other valid. The third request remains unused until row 13. |
| 3 | For the auth-edge alias, operations expires one unused link. Open its GET and press its unchanged **Open my cabinet** button. Separately expire its valid session server-side and revisit a protected URL with browser storage intact. **Controlled TEST expiration + Browser** | GET still shows confirmation because it never checks or spends the token. POST is refused with `That link does not work`, the expired-or-used explanation and **Ask for another link**. Expired session redirects to sign-in, never to a false empty state. |
| 4 | Exercise report handoff for a fresh identity, then returning behavior without changing the known account. **Browser** | Fresh: report → one **Open my cabinet** click → cabinet, with no extra cabinet confirmation or email. Returning report/reload: email link → ordinary explicit confirmation → existing merchant. Neither path duplicates or misattaches a merchant. |
| 5 | Run the existing isolated test that makes the gateway unavailable during merchant creation; do not disrupt shared TEST. **Isolated automated failure** | Person stays signed in, sees a temporary failure and **Try again**, and retry creates one merchant without another email. Mark deployed UI unexercised unless a safe TEST injector exists. |
| 6 | Create the fresh merchant. Try blank seller name, missing wallet, malformed address and bad checksum before saving valid prerequisites. Reload and reauthenticate between edits. Issue one TEST key, reload the result, then deliberately issue another only if needed to observe explicit issuance. **Browser** | Errors are actionable. Address checks claim syntax and checksum only, never chain, ownership or control. Settings persist. Key is TEST-scoped and secret appears once. Reload follows PRG and never repeats issuance; deliberate issuance may create a new key and makes that consequence clear. |
| 7 | In a clean directory outside the repo, use only published docs and package. Exercise missing key, wrong environment, malformed card, every missing required field and invalid result; then verify and publish one honest cheap card. **SDK runtime + Browser** | Invalid input fails before ambiguous publication or settlement. Valid card appears once with matching seller, TEST cue, price and IDs. Record each verifier subcheck and exit code: exit `3` means not run, so idempotency exit `3` cannot make the verifier wholly green. |
| 8 | Stop the handler and ask the capped operator path to attempt purchase; inspect order and payment evidence, then restart the same key and ledger. **Operator purchase + SDK runtime + Browser** | With no handler, purchase is refused before settlement: no delivery, receipt or ledger entry, and UI does not claim delivery. Restart does not revive the closed attempt. This does not assume presence display or automatic card pause. |
| 9 | Explicitly pause this card in cabinet, probe the public card and resource without buying, then resume and probe again. **Browser + SDK runtime** | Paused: absent from catalogue, resource is `409 not_selling`, no payment challenge. Resumed: listed, resource presents its TEST `402` challenge. No funds move. |
| 10 | Run one ordinary purchase at `≤0.01` test USDC. Correlate buyer, merchant, handler, settlement, goods and receipt by stable IDs. **Operator purchase + SDK runtime + Browser** | One payment attempt, one handler invocation, one provision, one delivered terminal order, one settlement and one receipt; buyer goods and merchant order agree and say TEST. |
| 11 | Run a separate purchase at `≤0.01`. Handler persists by `order.id`, provisions once, then throws before answering; gateway synchronously redelivers the same order; handler returns the saved result. **Operator purchase + SDK runtime** | Same order reaches the handler twice; counts are 2 invokes, 1 provision, 1 delivered state, 1 settlement and 1 receipt. Verifier or unit-test output cannot substitute for this replay. |
| 12 | Separately stop and restart the normal handler against the same key and ledger, then read open orders. Make another ordinary or supported async purchase at `≤0.01` only if readback cannot prove recovery and budget remains. Combine restart with row 11 only if first proven safe inside the eight-second synchronous window. **SDK runtime; Operator purchase only if needed** | Restart preserves ledger, key and catalogue and never reprovisions a completed order or creates a second settlement. Record whether evidence was readback-only, synchronous or async. |
| 13 | After fulfillment, inspect the completed journey in the still-valid main session. Operations expires that session server-side; revisit the order URL, then spend the reserved third main-alias request to reauthenticate. Inspect merchant, settings, key record, card, order and receipt; verify the other browser session independently. **Browser + Controlled TEST expiration + SDK reconnect if needed** | Valid session needs no email. Reauth returns to the same merchant and preserves settings, key identity, card, order, status and receipt. Secret stays unrecoverable while the key works. Expiry never masquerades as empty data. If the hourly limit blocks the reserved request, record the exact wait and resume after reset rather than bypassing it. |

## Closeout

The evidence table contains row, candidate/version, actor, action, expected, observed, evidence link or ID, UX answers, verdict and every private hint or retry.

- **Pass:** one final candidate completes every applicable row, including ordinary fulfillment and real replay counts.
- **Partial:** the supported journey completes but a named recovery or evidence mode did not run.
- **Fail:** accepted work loses, duplicates, misattributes or misstates identity, money, goods or order state; a newcomer cannot reach the operator handoff; or recovery needs undocumented intervention.
- **Blocked:** a named external capability prevents only dependent rows; state the smallest unblocker.

Set an existing TEST acceptance marker only when its exact contract is fulfilled by evidence from the final SHA. Do not create a marker contract, promote production or close Stage 4 from this operator-owned run.

## Known findings to verify

1. The cold public site does not expose the merchant or SDK path, and empty Cards has no local first-sale action.
2. Quickstart promises an operator purchase “on your signal” while no public readiness channel exists. The contact decision is `USER-DEFERRED`; privacy and abuse addresses are not substitutes.
3. The link-sent screen clears the known email on Back, offers no same-screen resend and says only “wait a moment,” while the real limit is three requests per address per hour.
4. Public docs say “before pilot,” describe seller identity as unsettled and present WooCommerce as a supported peer, contrary to Stage 4 and the cabinet.

## Source anchors

`AGENTS.md:3-10`; `docs/research/19-portal-requirements.md:95-103`; `docs/research/21-pilot-plan.md:55-65`; `docs/decisions/0026-one-way-in.md:25-93,166-205`; `apps/docs/quickstart.md:44-64,103-200,201-477,499-521`; `apps/cabinet/src/server.test.ts:630-660,704-732,2543-2559`; `apps/cabinet/src/identity.test.ts:42-82`; `apps/cabinet/src/screens.ts:240-270`; `packages/sdk/src/verify.ts:37-47`; `packages/sdk/src/worker.test.ts:177-203`; `packages/sdk/src/outside-fixtures.test.ts:212-286`.
