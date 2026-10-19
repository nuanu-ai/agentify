# 0011. The order identifier is the agent's proof

Date: 2026-08-27
Status: accepted for the controlled launch; for a public audience on 2026-10-19

## Context

An agent that buys an asynchronous product receives an order before the goods
exist and collects them later from `GET /x402/orders/:order_id/status`, so that
route needs a rule for who may ask. Merchants have keys; buyers deliberately do
not, since registering first would undo buying with no prior relationship.

## Decision

Knowing the order identifier is the proof, on both channels. Whoever presents
it is answered about that order and no other. The identifier is random,
impractical to guess and in no catalog or listing; Agentify and the merchant
hold it too, as parties to the sale. It is a key to one order, not proof of
having paid for it, which comes only from the verified payer.

The answer is `agentOrderStatusOf` in `apps/gateway/src/app/runner.ts`, the same
document the purchase returns, built field by field so that nothing reaches it
until someone writes it there: the order's state and price, the goods once
delivered, a parcel's shipment once shipped, whether the sale was a test, who
sold it, the merchant's own words where the merchant refused it, and Agentify's
reason where Agentify ended it or a refund is owed and the status alone would
blur the next step. It leaves out the merchant's product key, the parameters
and address the buyer sent, and every other order. Every identifier that names
no order gets the same `no_such_order`, so probing learns nothing. Every answer
of the route tells caches to keep nothing (`Cache-Control: no-store`), and the
order document and the site's `llms.txt` tell the agent that the identifier is
the key to its goods and is not to be shared.

## Consequences

Asynchronous purchases have a collection path, and the weakness is explicit:
anyone who obtains an identifier through a log, a proxy or an agent's store can
read that order, though not change it, act as its payer or list other orders.
For a parcel that includes its tracking number and link, whose carrier page may
show the buyer's city or who signed for it (ADR-0033), and for every order the
seller's name and site as our catalog shows them (ADR-0034).

The product owner accepted this bearer risk for the controlled launch, which
had no external users. The live catalogue now sells to any agent, so on
2026-10-19 the door was revisited, weighing the goods, a parcel's shipment and
the seller, and accepted for that audience as it stands: an identifier leaks
only where somebody writes it down, and the agent is now told not to. Parcels
on the live channel still wait for the rest of what ADR-0033 names.

## Alternatives rejected

Leaving the route unmounted avoids the weak door but takes money for an
asynchronous product that an agent cannot collect. Giving buyers accounts and
keys turns buying into signing up, while the product exists so that an agent
with a budget can buy without a relationship first.

Making the agent prove control of the paying address, which x402's
Sign-In-With-X allows, remains the long-term direction. It is not taken now:
it asks every buyer's client for a second signature the purchase does not
need, and which clients can give one is not known.
