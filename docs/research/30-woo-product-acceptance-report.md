# WooCommerce TEST product acceptance report

**Execution checkpoint:** 2026-09-18. COIN-25 remains in progress. TEST runs
application revision `c77dd57fa0e80a245728e005412cb992f5a9b526`. All four
authorized signed slots are consumed. Three settled and delivered; the fourth
failed during facilitator settlement before Woo was called. The ordinary
purchase and revoked-key recovery passed. The first committed-empty-response
attempt delivered normally because its controlled hook did not match, and its
replacement never reached Woo, so that recovery remains unproven. No additional
live payment is authorized. The product verdict is therefore `Partial`; scoped
closeout completed without another fixture reset.

Production and real funds are outside this run and were never used.

COIN-41 completed the controlled external SDK rehearsal. Stage 4 remains active
because that controlled run is not the first uncontrolled merchant. The SDK is
the primary product path. WooCommerce is an experimental connector and neither
gates Stage 4 nor changes the SDK result.

## What this run represents

The run created a separate Agentify merchant through the public cabinet. It did
not create a WordPress user or shop: the existing `woo.nuanu.ai` shop and its
existing administrator were reused. Operations performed one authorized normal
fixture reset before the run. A second reset is neither required nor allowed
for closeout because the shared shop may now contain user activity.

The reset catalogue's five gift-card products cannot issue the experiences or
vouchers their names promise. They remain unsupported evidence, not successful
goods. The product owner added one clearly named, owned TEST download through the ordinary
Woo editor: a USD 0.01 simple, virtual, downloadable product with one protected
148-byte file. It grants no gift value, service or real-world entitlement.

The result stays agent-first. Agentify returns the order's native Woo permission
and the agent retrieves the bytes. No buyer email is requested. Woo's merchant
order email remains an internal order fact and does not appear in the result.

Agentify does not calculate tax. This connector supports only a shop whose
global Woo tax-calculation setting is exactly off. A product's dormant
`tax_status=taxable` default is irrelevant while global calculation is off; an
enabled, missing or unreadable global setting is refused. After Woo creates an
order, its currency, line total, order total and zero tax must still equal the
settled amount before Agentify releases goods.

## Evidence levels

**Live** means root or operations observed the behavior on deployed TEST at the
revision above. **Controlled live** is a capped buyer, chain, Woo or restart
check against the dedicated acceptance merchant. **Isolated** is automated or
fault-injected proof and is never presented as deployed merchant behavior.
**Pending** means the pre-registered live case has not completed. Raw links,
credentials, payment payloads and Woo permission data remain outside this
report; stable public identifiers and hashes are included where useful.

## Outcome matrix

This table uses the row numbers and decision rules frozen in
[`29-woo-product-acceptance-protocol.md`](29-woo-product-acceptance-protocol.md).

| Row | Status | Evidence and product outcome |
|---|---|---|
| 1 | Live pass with accepted fixture drift | The one normal reset restored five products, no orders and no API keys. Public TLS and services passed. The restored title was `Nuanu Digital Gifts — Test Store`, while the fixture verifier expected `Test Gift Shop`; this was accepted as title-only drift and the store was neither rebuilt nor renamed. |
| 2 | Live pass | A new Agentify merchant entered through public email sign-in, kept one identity across reload, logout and reauthentication, and found the experimental Woo path while the SDK remained primary. |
| 3 | Mixed live and isolated pass | Plain HTTP was refused with repairable input; real public TLS Connect passed after the scoped TEST hairpin route. Public-only DNS pinning, private/mixed-address refusal, no credential forwarding and redirect refusal are isolated tests. No live private-address probe was used as acceptance evidence. |
| 4 | Live pass | Deny, reconnect, callback, Back/reload and expiry while Woo approval was open preserved the merchant. At `c77dd57`, the signed reauthentication destination returned directly to the Woo page with a truthful session-ended message. |
| 5 | Mixed live and isolated pass | Live callback state was account-bound and survived reauthentication. Missing, expired, replayed and out-of-order callbacks are isolated proof; explicit Forget removes all same-account intents so a late callback cannot recreate the connection. |
| 6 | Live pass | Import left all five nondownloadable baseline gift cards behind and published none as order-number-only goods. |
| 7 | Mixed live and isolated pass | Product 22 passed authoritative product/settings and actual raw-file 403 checks. A baseline nondownloadable product received a specific refusal. The current Woo page visibly states the tax-disabled and supported-download boundary. Tax, stock, file, download-policy, raw-public and unreadable-state negatives are isolated proof. |
| 8 | Live pass | Product 22 imported once as stable item `item_5f29fa33975c4e989aa7c9f22c1ea8a0`, asynchronous, price-checked and USD 0.01. Reimport did not duplicate or resume a paused card; resume restored exactly one public item. |
| 9 | Isolated pass | Shop origin is part of card identity. A same-numbered product at another shop cannot fulfil this card. No extra live purchase was made. |
| 10 | Isolated pass | Fresh quote revalidates price and all supported product/settings facts before money. No extra live mutation or authorization was spent. |
| 11 | Isolated pass | The accepted `price_id` binds delivery-critical facts, including a digest of the protected source address. Drift becomes refund debt with zero Woo POST. Bytes replaced behind an unchanged protected URL remain an explicit limit. |
| 12 | Mixed live and isolated pass | The final live authorization ended `settle_failed` with one payment claim but no transfer, goods, receipt, Cabinet Woo row, Woo order or permission, and Agentify did not retry it. Unknown settlement remains isolated proof. |
| 13 | Controlled live pass | Happy case used one signed request for 10,000 atomic TEST USDC. Agentify order `ord_63030767f4624205a0b86d8fdadc4334` settled before one paid Woo order 24, with USD 0.01, Agentify correlation and one native permission. |
| 14 | Controlled live pass | Receipt `rcp_b8d4e62fa51c4cf2b68f9730d362eb52` delivered `Agentify TEST acceptance artifact`. Direct no-redirect retrieval returned `agentify-test-download-dn3er7.txt`, 148 bytes, SHA-256 `92a457abce8665901afcf82e30afe432cf4f19f78035f3e3d763ddbd39f0c7c2`. Cabinet restart and repeat retrieval returned the same result without another payment, order or permission. |
| 15 | Mixed live and isolated pass | Live restart preserved one charge, Woo order, permission and receipt. Concurrent redelivery, durable-bind failure and lost `answer_order` response remain isolated proof. |
| 16 | Controlled live fault experiment unproven; isolated product pass | The first attempt, order `ord_14fd2e15201b455d9eb333610f12a925`, delivered normally as Woo order 26 because the reviewed one-shot hook did not consume its option. The corrected hook then passed no-purchase proof and readiness, but replacement order `ord_e96a08aa0aa24bb3b9af24d294c75036` failed facilitator settlement before Woo was called. Neither attempt produced `create_unknown`, debt or exact-id recovery evidence. Hook and options were removed. Isolated tests still prove monotone unknown handling and zero blind re-POST, but they are not deployed evidence. |
| 17 | Isolated pass | Failure to durably bind a valid Woo create result releases no goods and cannot cause another POST. No extra paid case is registered. |
| 18 | Mixed live and isolated pass | Live Cabinet restart proved durable placed-result readback. Crash before, or loss of, the gateway answer is isolated proof. |
| 19 | Controlled live pass | A corrected unsigned `{"params":{}}` request against revoked credentials reached the pre-price boundary with no payment or Woo side effect. In the paid case, order `ord_b73d4ac1199d4d7ab77315e1cf827532` settled once, then reached visible open `refund_due` with no Woo order, receipt or goods after the exact current key was revoked. An earlier `request_nonce` attempt was invalid client input and remains a deviation, not evidence. |
| 20 | Partial controlled live; committed-create recovery unproven | After an ordinary same-shop reconnect, the private exact-order command created Woo order 25 and one permission, late-delivered the same Agentify order and issued receipt `rcp_6b7f13aacc424cc3af31a6011ba62375`. The file was the exact 148-byte artifact, and one idempotent command rerun changed no order, receipt, permission, authorization or balance count. Exact state transitions and exact-id validation pass in isolation. Neither committed-response attempt entered `create_unknown`, so exact-id recovery was not exercised. |
| 21 | Controlled live pass | The intact native permission worked without cookies or redirects and from another clean handoff. Mutating order key, product, download or `uid` returned no goods. This proves a bearer capability, not wallet binding. |
| 22 | Mixed live and isolated pass | The raw protected source returned 403. The public card and receipt did not carry the capability or merchant secrets. Broader log/UI secret negatives remain isolated checks; the full permission URL is absent from this report. |
| 23 | Isolated pass | Wrong or duplicate correlation, product, total, currency, billing, paid-state and permission facts refuse binding and delivery. Live exact-id recovery remains unproven in case 3. |
| 24 | Live pass | The acceptance card is paused. The one-shot hook and option are absent, private ephemeral handoffs were removed, and only stale keys proven to belong to this run were revoked. The working dedicated connection and its current exact key remain for review. The shop, product 22, Woo orders 24–26, permissions, receipts and user activity remain. No second reset was performed. |

## Paid evidence at this checkpoint

The durable ledger contains four execution reservations and one retained
expired unsigned preparation. It has consumed the amended 40,000-atomic signed
authorization ceiling, while only 30,000 atomic units settled. Happy-path transaction
`0x68a36ff275a2fca6ed599318083b7376f050e46a17aa4651a1907b6e0e7b9309`
and revoked-key transaction
`0xf535f1a43728917c5a332b595dcc4faa8cc1b0ffe9812776416c441db7dbc2c8`
each transferred exactly 10,000 atomic TEST USDC. The first fault-fixture
authorization also settled 10,000 atomic TEST USDC and delivered normally. The
replacement authorization returned terminal `settle_failed` after the external
facilitator returned `replacement transaction underpriced` for its settlement
submission. It created one payment claim but no transfer, balance change,
receipt, Cabinet Woo tracking row, Woo order or permission. There are therefore
three delivered paid Agentify orders, three receipts, three Woo orders and
three native permissions. The upstream sender logs were not retained, so the
exact external nonce or fee cause is unknown; no Agentify settlement retry or
concrete local source defect was found. No paid request was retried or
authorized twice. COIN-43 tracks
revalidation of this remaining settlement failure.

Paid case 2 completed the exact registered sequence: one valid quote, exact-key
revocation before dispatch, one signature, visible `refund_due` with no Woo
order, ordinary same-shop reconnect, then private exact-order late delivery of
the same order without another authorization. Its native permission returned
the expected display name and protected basename, 148 bytes and the frozen
SHA-256. A second invocation of the recovery command was an idempotent readback.
The first case-3 attempt did not produce the registered fault. Its order
`ord_14fd2e15201b455d9eb333610f12a925` became an ordinary delivery through Woo
order 26 and returned the exact artifact. The one-shot hook remained armed
rather than suppressing the response, so no ambiguous create or operator-
supplied exact-id recovery occurred. Operations removed the hook and option.
This is a successful ordinary purchase and a failed acceptance experiment, not
evidence for committed-create recovery.

The one authorized replacement used fresh order
`ord_e96a08aa0aa24bb3b9af24d294c75036` after the corrected hook passed actual-
Woo no-purchase and web-readiness checks. Its signed request ended HTTP 409,
terminal `settle_failed`, because the facilitator settlement submission was a
replacement transaction underpriced. Woo was never called and the one-shot was
not consumed. This is a payment-settlement failure, not a second fixture-match
failure and not an unknown Woo create. It left no recovery candidate. The full
0.04 authorization ceiling is exhausted and no further purchase is authorized.

The first case-2 orchestration invocation completed one unsigned preparation,
creating order `ord_fcc7e8f05232450fa3923b684b997339`, then the shell refused on
a readonly variable before credential revocation, key access, signature or
payment. The held quote expired. The current Woo key and all commerce state
were unchanged. This is an operator-runner deviation, not a product outcome,
and the failed preparation remains in the append-only evidence.

The first correction did not add a paid case or increase funds. After offline proof,
independent review and explicit root authorization, the ledger marked the
expired attempt `aborted_unsigned` without deleting its evidence, then appended
one replacement `revoked-precreate` row with `replacement_for_attempt: 2`, a
fresh order and challenge. The expired order and challenge were not reused.
The first case-3 attempt followed it. A second prospective amendment then
preserved that ordinary delivered row and admitted one fresh replacement after
the corrected fixture passed proof and review. The final ledger has five
preparations, exactly four execution reservations and signatures, and a 40,000-
atomic authorization ceiling, still 10,000 per execution. There was no generic
retry loop or reused challenge, order or nonce.

## Merchant outcome and current boundary

The working claim already exceeds “a Woo order number exists.” A cold owner can
connect the existing HTTPS Woo shop, see unsupported gift cards refused, import
the supported download, and make an agent receive the exact promised bytes.
The owner does not supply buyer email, handle the native permission, or think
about worker restart. The happy purchase is a controlled live pass.

Failure recovery is not self-service. The connector deliberately refuses blind
remote-order retries, and its safe closure is a private operator command bound
to one Agentify order and, where needed, one exact Woo order id. The public
merchant flow has no recovery control. Dmitry deferred the public pilot-contact
decision, so this report does not invent an address, CTA or claim that an
unassigned merchant can close refund debt alone. Even if both recovery cases
pass, the result is a working operator-assisted pilot connector, not autonomous
WooCommerce support.

The remaining merchant-facing clarity is material. Receipts lead with a long
explanation of price timestamps and missing obligations before the actual
receipt. Orders expose machine states and identifiers. In case 2 the warning
truthfully said money was taken, nothing shipped and late delivery can clear
the debt, but its only stated action was for the owner to return funds from
their own wallet. It did not direct the owner to reconnect the shop or request
operator recovery for that exact order. With the public pilot-contact decision
deferred in COIN-42, the safe
late-delivery path remains discoverable only to the operator.

## Verdict and product boundary

The product verdict is `Partial` because rows 16 and 20 still lack deployed
committed-create recovery evidence. Row 24 cleanup passed. The run left exactly
three delivered paid Agentify orders, three Woo orders, three receipts and
three native permissions totaling 0.03 TEST USDC, with no unresolved
acceptance-merchant obligation. The Agentify order history also retains the
unsigned expired priced order and the terminal settlement-failed replacement;
neither is a delivered purchase or merchant obligation. The private ledger
retains five preparation rows and exactly four execution reservations and
signatures. Only three settled. The one-shot fault is absent, the authorization
ceiling is exhausted, and no further live payment is authorized. COIN-43 tracks
the external settlement failure and its revalidation. No refund settlement was
executed or proved in this run; the paid failure that closed did so through
late delivery of the promised goods.

The final state pauses the acceptance card but retains the working dedicated
merchant connection and current Woo key for review. Forgetting the shop was not
required to prove cleanup and would have removed useful evidence. Only stale
acceptance keys and private ephemeral handoffs were removed; no personal or
shared credential was touched. Product 22 and every order, receipt and
sanitized evidence record remain.

The connector passes the narrow operator-assisted TEST path for a single
protected, unmanaged-stock Woo download when global Woo tax calculation is
off, including late fulfillment after a definite pre-create failure. This is a
connector support and quote-integrity boundary, not a tax engine, a tax-
compliance finding or advice to change an operating shop's tax configuration;
unsupported shops are refused. Committed-create recovery remains unproven. The
connector still does not support the five fixture gift cards, managed stock,
physical or variable products, multiple files, finite download limits,
arbitrary external file stores, autonomous unknown-order discovery or merchant
self-service recovery. The controlled SDK acceptance passed separately; this
partial experimental Woo result neither closes Stage 4 nor changes its SDK-
primary acceptance boundary.
