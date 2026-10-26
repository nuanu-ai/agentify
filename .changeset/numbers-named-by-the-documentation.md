---
"@nuanu-ai/agentify-contracts": patch
---

The descriptions of `PayoutWalletSchema` and of the `get_payout_wallet`,
`list_orders`, `purchase_item` and `get_order_status` routes no longer state
Agentify's commission, how long a price holds, how many of a seller's purchases
may wait for payment, how long a seller's process may go without polling, or
how long an order that ended with nothing charged is kept. Each says what the
limit is and where the documentation names it, from the gateway's own
numbers; the payout wallet's description drops its worked example of a first
payout, which only held at one rate. Nothing a call sends or answers changes.
