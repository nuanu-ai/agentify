# Status of the 27 October merchant report

The report is Stefan Abrudan's Agentify test-channel handoff dated
2026-10-27. It reviews source at `8bc2957`; the report does not establish the
deployed revision. Its 25 scenarios and additional checks are bounded evidence,
not acceptance of every product path. The product owner asks for an eventual
reply covering every finding, including explanations for deferred proposals.

Work proceeds one finding at a time: explain the problem and proposed response,
get agreement, implement or verify that it is already resolved, then stop for
the next discussion. PR #211 is merged. Further accepted work shares the
`agent/verified-purchase-admission` branch in [PR #216](https://github.com/nuanu-ai/agentify/pull/216) so it can be reviewed together. It replaces PR #215 because GitHub forbids rewriting that branch.

| Finding | Current status | Evidence or remaining work |
| --- | --- | --- |
| ENG01: reporter's acceptance runner | Outside the product fix scope. | The reporter identifies this as their own harness and is fixing it. The synthetic 9.99 USDC example is not an on-chain charge. Do not describe it as a defect in Agentify's tests. |
| ENG02: lost paid answer | The buyer example is fixed in [PR #211](https://github.com/nuanu-ai/agentify/pull/211). | It saves requirements before payment and resumes the same purchase. The [recovery check](2026-10-27-buyer-example-recovery.md) verifies no extra debit on TEST. This does not update third-party buyer clients. |
| ENG03: buyer state file permissions | The example enforces private state-file permissions in PR #211. | Existing purchase journals are corrected to 0600; storage failure refuses payment. Previously written legacy files are not automatically migrated. |
| ENG04: purchase response caching | Verified on TEST at `1ddf951a` in PR #216; human review and production rollout remain pending. | The [cache-protection check](2026-10-27-purchase-response-cache-control.md) covers purchase, recovery and order-bearing errors. Discovery probes still create no order; final TEST verification is recorded in the [28 October response](2026-10-28-pr215-review-response.md). No cache leak is established. |
| ENG05: empty wallet receives signing advice | Reported wrong advice is not reproduced on current TEST. | The code already changes through [PR #201](https://github.com/nuanu-ai/agentify/pull/201). The [recheck](2026-10-27-eng05-payment-refusal-recheck.md) distinguishes unknown cause, wrong signature and wrong chain with zero spend. Explicit insufficient-funds codes have a funding instruction offline. The live service gives a generic refusal, so this is not a claim of reliable balance diagnosis. |
| ENG06: conflicting repeated delivery | Proposed diagnostic improvement; no implementation decision. | The original goods remain intact. Evaluate a signal to the merchant without adding an overwrite path or exposing credentials. |
| ENG07: terms before async payment | The approved smaller solution is verified on TEST in PR #216; human review and production rollout remain pending. A separate machine-readable policy is deferred. | The [site and payment-timing rule](2026-10-27-prepaid-seller-terms.md) requires the existing seller site for async and parcel publication and new purchases, including a previously quoted first payment. Paid recovery and fulfillment continue. Buyer instructions explain prepayment and direct buyers to merchant terms; site ownership, policy content and refunds remain unverified. |
| ENG08: build identity, capacity and timing | Public build identity and bounded unpaid pricing are verified on TEST in PR #216; human review and production rollout remain pending. Sustained capacity and timing remain open. | The [build-identity check](2026-10-27-public-build-identity.md) verifies public commit and contract fields, unknown values and the private configuration boundary. The branch removes the fifty-unpaid-order limit and uses a separate gate: four active price questions and sixteen admissions per second per merchant. These constants are not measured shop capacity. API, settlement and RPC timing still need separate assessment. |
| F11: old worker leaves a live card without fulfillment | Admission protection is fixed in PR #211; production rollout remains pending. | Sales require recent compatible contact. TEST checks missing and earlier poll versions, then completes paid orders with the branch SDK. Publishing the matching SDK and preparing merchants are still required before production activation. |
| F13: transient worker polling errors | Observation requiring attribution. | The reporter's worker recovers with no affected order. No product cause is established. |
| F14: price question with example locality | Observation requiring attribution. | A validator or crawler is a hypothesis. A schema-shaped unpaid attempt also appears during our TEST check; its sender is unconfirmed. |
| Seller capacity fairness | Agreed bounded-admission and stateless-price design is verified on TEST at `1ddf951a` in PR #216; human review and production rollout remain pending. | Unpaid prices occupy no durable order or counter; ready accepted work precedes transient questions. Merchant gates are separate. Fairness between callers and shared database/facilitator isolation remain open; no sustained abuse test is claimed. See [design and limitations](90-unpaid-price-questions-design.md). |
| Unpaid attempts in the dashboard | The merchant Lapsed view and its reads are removed in PR #216. | Unpaid prices and failed verification create no orders or order-created events. Only verified, atomic admission persists ownership and a nonce claim. The obsolete unowned-attempt retention and operator Lapsed classification are removed; financial history remains. Review corrections and bounded TEST acceptance are recorded in the 28 October response; production rollout remains pending. |
| Coinbase validation and discovery | Discovery listing is unconfirmed. | TLS failure is external to Agentify. Record environment and date for any recheck; a validation response alone is not proof of discovery visibility. |

The buyer-generated-secret design is deferred. Its
[consequence map](2026-10-27-buyer-key-impact-map.md) records changes to order
ownership, retention and existing purchases. The chosen example fix addresses
the reported restart failure within the current buyer contract. Do not call
that deferred design implemented, or claim the number of map rows measures
implementation effort.

The eventual reply needs the fixed items and their releases, the items already
resolved and rechecked, the deferred proposals and their reasons, and the
remaining unknowns. The existing [buyer reply draft](2026-10-27-buyer-example-recovery.md#draft-reply-to-the-report-author)
covers ENG02 and ENG03; it is not the final reply for the whole report.

The [whole-report reply draft](2026-10-27-merchant-report-reply-draft.md) records
all current dispositions. It has not been sent and must receive release and
final TEST evidence before it is used as a delivery report.

The [28 October review response](2026-10-28-pr215-review-response.md) tracks the
six pre-merge findings, the owner's cart-replacement decision and the evidence
required for PR #216. Earlier green runs did not cover those
races and are not acceptance of the corrected implementation.

TEST `1ddf951a` completed two 0.01 test-USDC purchases, recovered the first
with no extra debit, preserved the original six-card catalogue and disabled
the temporary merchant keys. See the 28 October response for the failed image
startup, packaging repair, negative controls and acceptance limits.
