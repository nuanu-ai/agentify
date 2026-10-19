# 0028. Late goods settle a refund owed until a refund is recorded

Date: 2026-09-23
Status: accepted (the product owner, 2026-09-23, 2026-09-28; commission,
2026-10-14; self-service, 2026-10-19). The state machine handles late goods
and recorded refunds. Recording a refund and showing its payer to the merchant
are not built; there is no staffed refund service.

## Context

An asynchronous order past its delivery deadline becomes `refund_due`: the
buyer has paid and the merchant owes goods or the whole price back from their
own wallet (ADR-0019). Agentify does not observe a transfer from that wallet.
The order stays on the open-order list, so the merchant's worker may still
try to deliver it. Closing a debt on an unverified report would let a seller
keep both the money and the goods.

## Decision

Late goods settle the debt until a refund is recorded. Before that, delivery
closes the order as `delivered`. `refund_due` is not final and has no deadline
of its own. A recorded refund makes the order `refunded`, which is final, and
later delivery is refused. A transfer that Agentify has not recorded does not
stop delivery; the public contract must say so.

Refunds belong to merchant self-service. The merchant's system initiates and
executes them; Agentify supplies the sale's payment facts, verifies repayment
evidence and coordinates its own delivery. Agentify neither signs a merchant's
transfer nor keeps their key. A seller or administrator saying "refunded" is
not proof: a refund may close an order only after the system verifies payment
back to the original payer, on the sale's network and in its asset, for the
whole price. The evidence must belong to this sale and cannot settle another
order as well. Unknown payer, missing evidence and an unavailable network are
unresolved cases, never a successful refund or proof that no transfer happened.

Before this flow is offered, it must also prevent an in-flight refund and a
late delivery from completing together. Merely accepting a transaction hash
after the seller sends money is insufficient. Its reservation, verification
and recovery rules need implementation and tests before the portal promises
that the system protects a refunding merchant from late delivery.

The merchant refunds the whole price, including the 0.1% commission, which
stays with Agentify (the product owner, 2026-10-14). The split and its warehouse
return no commission (ADR-0037). The payer, amount, asset, network and the
recorded result must be visible to the merchant. No support contact is a
required step. Agentify promises no manual intervention after three business
days, no goods-or-money guarantee at fourteen days, and no payment from its own
funds to cover an unresolved order.

A refund for a parcel the merchant admits lost follows the same evidence rule.
It moves a shipped order to `refunded`, for parcels only (ADR-0033). It must
not reopen the order as `refund_due`, where a stale shipment could close it.
Parcel sales remain refused on live until their existing readiness gates hold.

## Consequences and alternatives

The merchant controls their money and delivery; the system must distinguish
what it verified from what somebody asserted. The current recording gap stays
visible in the portal and in `docs/research/52-self-service.md`.

Rejected: a staffed reconciliation queue or an Agentify-funded backstop; an
unchecked merchant or administrator refund button; a second settle to resolve
a silent charge; and returning the commission in a separate transfer. None
provides a safe, unattended completion of this sale.
