---
"@nuanu-ai/agentify-contracts": patch
"@nuanu-ai/agentify": patch
---

Merchants can stop future Agentify fulfillment through an authenticated,
idempotent order close call, with an optional message attributed to them.
The SDK exposes `order.close({ message })` on each bound order. Repeating it
preserves the first closure; delivered and shipped orders refuse it.

Order read views carry the original `payment_status` separately from optional
`merchant_closure`. Closing cancels no accepted payment execution, so original
payment verification and recovery may still update its outcome without another
charge or release of goods. Agentify confirms no refund or agreement.

Replace refund obligations and confirmations with factual `unfulfilled` and
`fulfillment_closed` statuses, the `order.unfulfilled` event and its reason,
`delivered_late` success and `fulfillment_closed` error. Remove the old refund
names rather than keeping aliases. Historical receipt outcomes use the same
factual vocabulary; current issuance still records only delivered or shipped
sales. The contract version remains `2` under ADR-0006 until the first merchant
we do not control; pilot workers must keep the package current.
