# Status of the 27 October merchant report

The report is Stefan Abrudan's Agentify test-channel handoff dated
2026-10-27. It reviews source at `8bc2957`; the report does not establish the
deployed revision. Its 25 scenarios and additional checks are bounded evidence,
not acceptance of every product path. The product owner asks for an eventual
reply covering every finding, including explanations for deferred proposals.

Work proceeds one finding at a time: explain the problem and proposed response,
get agreement, implement or verify that it is already resolved, then stop for
the next discussion. PR #211 is merged. Further accepted work shares the
`agent/report-followups` branch; a new pull request is not opened yet.

| Finding | Current status | Evidence or remaining work |
| --- | --- | --- |
| ENG01: reporter's acceptance runner | Outside the product fix scope. | The reporter identifies this as their own harness and is fixing it. The synthetic 9.99 USDC example is not an on-chain charge. Do not describe it as a defect in Agentify's tests. |
| ENG02: lost paid answer | The buyer example is fixed in [PR #211](https://github.com/nuanu-ai/agentify/pull/211). | It saves requirements before payment and resumes the same purchase. The [recovery check](2026-10-27-buyer-example-recovery.md) verifies no extra debit on TEST. This does not update third-party buyer clients. |
| ENG03: buyer state file permissions | The example enforces private state-file permissions in PR #211. | Existing purchase journals are corrected to 0600; storage failure refuses payment. Previously written legacy files are not automatically migrated. |
| ENG04: purchase response caching | Confirmed in current code; proposal awaiting agreement. | The status route sets `no-store`, while purchase and recovery do not. No cache leak is established. |
| ENG05: empty wallet receives signing advice | Reported wrong advice is not reproduced on current TEST. | The code already changes through [PR #201](https://github.com/nuanu-ai/agentify/pull/201). The [recheck](2026-10-27-eng05-payment-refusal-recheck.md) distinguishes unknown cause, wrong signature and wrong chain with zero spend. Explicit insufficient-funds codes have a funding instruction offline. The live service gives a generic refusal, so this is not a claim of reliable balance diagnosis. |
| ENG06: conflicting repeated delivery | Proposed diagnostic improvement; no implementation decision. | The original goods remain intact. Evaluate a signal to the merchant without adding an overwrite path or exposing credentials. |
| ENG07: terms before async payment | Product and public-contract decision pending. | Assess what the buyer can learn about settlement timing, the merchant's policy and support before paying. Agentify does not confirm refunds. |
| ENG08: build identity, capacity and timing | Pending verification and proposal. | Health has no revision identifier. Recheck the 20/50 unpaid-order observation against a known deployment; separate API time from settlement and RPC reads. |
| F11: old worker leaves a live card without fulfillment | Admission protection is fixed in PR #211; production rollout remains pending. | Sales require recent compatible contact. TEST checks missing and earlier poll versions, then completes paid orders with the branch SDK. Publishing the matching SDK and preparing merchants are still required before production activation. |
| F13: transient worker polling errors | Observation requiring attribution. | The reporter's worker recovers with no affected order. No product cause is established. |
| F14: price question with example locality | Observation requiring attribution. | A validator or crawler is a hypothesis. A schema-shaped unpaid attempt also appears during our TEST check; its sender is unconfirmed. |
| Seller capacity fairness | Follow-up investigation pending. | Assess whether one caller can occupy the seller's waiting slots and what the current expiry and admission rules imply. No sustained abuse test is claimed. |
| Unpaid attempts in the dashboard | Follow-up verification pending. | Recheck the current default order view before proposing a change. |
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
