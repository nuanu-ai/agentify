---
"@nuanu-ai/agentify-contracts": patch
---

The status route's description stops calling the delivery deadline the end of
an order whose goods come later. When the deadline passes with no goods, the
order becomes `refund_due`. That is not an ending: goods the merchant delivers
afterwards still appear at `status_url` and settle the debt. `refund_due`
cannot say whether the money has already gone back. The comment on
`refund_due` in the status vocabulary says the same. The schemas do not change.
