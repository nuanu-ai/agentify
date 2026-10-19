---
"@nuanu-ai/agentify-contracts": patch
---

The purchase route's description says that the payment challenge names the
order it prices by a payment reference, `extra.payment_ref` in its payment
requirements, which comes back with the payment and binds it to that order,
and that the reference is not the order's identifier, which comes in the
purchase's answer and never in the payment request. It also says that a
payment for an order already over, with nothing held for it, is refused as
`payment_not_taken` in words that name no order, and that a payer whose
answer was lost signs the same challenge again from the same wallet and is
answered with the order, with no second charge, unless the order ended with
nothing charged or its payment's outcome is not known yet, when the refusal
says so. The status route's description, and the doc comment of its
`order_id` door, say that the identifier goes to the agent that bought and to
its merchant, while the payment requirements, which the payment facilitator
receives and a discovery catalogue can publish, carry the reference instead,
and the status route answers that reference as an unknown identifier. The
descriptions no longer say that the facilitator receives the identifier. No
schema, type or behaviour of the package changes, and `CONTRACT_VERSION` does
not move: the payment challenge is the storefront's, which carries no
version, and no worker of the merchant's SDK reads it.
