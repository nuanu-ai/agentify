---
"@nuanu-ai/agentify-contracts": minor
---

An order read back, from `GET /v0/orders/:order_id` and `GET /v0/orders`, can
carry `transaction`: the transaction that paid it. It is there once
`payment_status` is `paid` and a transaction was recorded, whether or not the
goods have reached the buyer, and absent before that and on a payment that is
`not_paid` or `unresolved`. It is the same transaction the buyer's order status
names and, once there is one, the receipt. A paid order that was never
delivered has no receipt, so until now nothing the merchant read named its
payment. The description of `GET /v0/receipts` points to the field.

The field is added at the top of an order read, which a reader keeps closed, so
`CONTRACT_VERSION` moves from `3` to `4`, and every schema's identity moves to
`urn:agentify:contract:4:<name>`. A reader built on version `3` refuses every
paid order read back with the field, so upgrade it before it reads orders.
