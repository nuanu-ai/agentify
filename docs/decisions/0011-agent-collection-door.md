# 0011. The order identifier is the agent's proof, for now

Date: 2026-08-27
Status: accepted for the controlled launch; revisited before an outside buyer

## Context

An agent that buys an asynchronous product receives an order before the goods
exist and collects them later from `GET /x402/orders/:order_id/status`, so that
route needs a rule for who may ask. Merchants have accounts and keys. Buyers
deliberately do not: making an agent register before buying would undo the
product's model of buying with no prior relationship.

## Decision

Knowing the order identifier is the proof, on the test channel and the live one
alike. Whoever presents it is answered about that order and no other.

The identifier comes from a random source, is impractical to guess and appears
in no catalog or order listing. It is not the buyer's alone: Agentify and the
merchant hold it too, as parties to the sale. It is a key to one order, not
proof of having paid for it; ownership of a payment comes only from the verified
payer.

The answer is `agentOrderStatusOf` in `apps/gateway/src/app/runner.ts`, the same
document the purchase itself returns, built field by field so that nothing
reaches it until someone writes it there. It carries the order's state and
price, the goods once delivered, a parcel's shipment once shipped, whether the
sale was a test, who sold it, and the merchant's own words where the merchant
refused it. It leaves out the merchant's product key, the parameters and address
the buyer sent, and every other order. Every identifier that names no order gets
the same `no_such_order`, so probing learns nothing about which strings were
ever orders.

## Consequences

Asynchronous purchases have a collection path, and the weakness is explicit:
anyone who obtains an identifier through a log, a proxy or an agent's store can
read that order. They cannot change it, act as its payer or list other orders.
What they read includes, for a parcel, its tracking number and tracking link,
whose carrier page may show the buyer's city or who signed for it (ADR-0033),
and the seller's name and shop site as our catalog shows them beside the
merchant's cards, with nothing of the merchant's account, product key or card
(ADR-0034).

The product owner accepts this bearer risk for the controlled launch: it has no
external users, so wallet sign-in would delay it without protecting anyone.
Before the first buyer or agent outside that launch, this decision is revisited,
weighing the shipment and the seller too, and the door is either narrowed or
accepted for the new audience, with the verdict written here. Selling parcels on
the live channel waits for that verdict (ADR-0033).

## Alternatives rejected

Leaving the route unmounted avoids the weak door but takes money for an
asynchronous product that an agent cannot collect.

Making the agent prove control of the paying address now remains the long-term
direction: x402's Sign-In-With-X lets the gateway ask a wallet to sign a
challenge and check that the caller controls the address. It is deferred until
the launch has an external user.

Giving buyers accounts and keys turns buying into signing up, while the product
exists so that an agent with a budget can buy without a relationship first.