# 0011. The order identifier is the agent's proof

Date: 2026-08-27
Status: accepted; revised 2026-10-19 (the product owner): fit for a public
audience wherever the gateway that keeps the identifier out of the payment
requirements runs

## Context

An agent that buys an asynchronous product receives an order before the goods
exist and collects them later from `GET /x402/orders/:order_id/status`, so that
route needs a rule for who may ask. Merchants have keys; buyers deliberately
do not, as registering would undo buying with no prior relationship. The
payment requirements reach the payment facilitator at every verification and
charge, and the x402 Bazaar (ADR-0012) publishes a listed resource's
requirements with `extra` as the last paying request carried it.

## Decision

Knowing the order identifier is the proof, on both channels. Whoever presents
it is answered about that order and no other. The identifier is random and
impractical to guess. It comes in the purchase's answer, never in the payment
request, and the merchant has it too. It is a key to one order, not proof of
having paid for it, which comes only from the verified payer.

The payment requirements carry a payment reference instead,
`accepts[].extra.payment_ref`, random like the identifier and kept with the
order. A paid request is bound to the order whose reference it carries back;
one authorisation presented again under another order's reference is refused
once checked, as a payment buys one order. Nothing answers a reference with
the order: the status route answers it as any unknown identifier, a payment
for an order that is over is refused in words naming no order, and a payer
who is not the buyer of a paid order is turned away before its address is
compared. So a listing may publish it.

The answer is `agentOrderStatusOf` in `apps/gateway/src/app/runner.ts`, the
document the purchase returns, built field by field so that nothing reaches it
unwritten: the state and price, the original payment's status, the goods once
delivered, a parcel's shipment once shipped, whether the sale was a test, who
sold it, the merchant's words where it refused, the merchant's closure and its
message where they closed fulfillment, and Agentify's reason where Agentify
ended the order, fulfillment is overdue, or a paid order was closed
(`merchant_closed`, ADR-0028). It leaves out the merchant's product key,
what the buyer sent and every other order. An identifier naming no order gets the same
`no_such_order` as any other, every answer tells caches to keep nothing
(`Cache-Control: no-store`), and the order document's description and
`llms.txt` tell the agent the identifier is the key to its goods.

## Consequences

Anyone who obtains an identifier through a log, a proxy or an agent's own
store can read that order, though not change it, act as its payer or list
other orders: for a parcel its tracking number and link, whose carrier page
may show the buyer's city or who signed for it (ADR-0033), and for every order
the seller's name and site (ADR-0034). A listing is not such a place.

## Alternatives rejected

Leaving the route unmounted takes money for an asynchronous product that an
agent cannot collect. Accounts and keys for buyers turn buying into signing
up. A secret token in `status_url`, with the identifier left in the
requirements, changes what every agent and merchant reads to repair what only
the payment side carries. Proving control of the paying address with x402's
Sign-In-With-X remains the long-term direction; not now, as it asks every
buyer's client for a second signature that few are known to give.
