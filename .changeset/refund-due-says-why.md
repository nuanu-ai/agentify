---
"@nuanu-ai/agentify-contracts": minor
---

An agent's order document says why a refund is owed. Every `refund_due` now
carries `reason`, whose code is the word the merchant's own
`order.refund_due` event carries — `refused`, `deadline_passed` or
`merchant_left` — and whose sentence says that nothing records a refund yet,
so the status does not change once the buyer is paid back. Where the
merchant's refusal is what left the debt, the reason stands beside their
`refusal`; on `rejected` and `expired` the reason is unchanged and never
stands beside one. `AgentOrderStatusSchema` lists the three words beside the
ending reasons, and the descriptions say the same. `CONTRACT_VERSION` does
not move: the agent's order document is the storefront's, whose codes are
open words (ADR-0006 §5), and no worker of the merchant's SDK reads it.
