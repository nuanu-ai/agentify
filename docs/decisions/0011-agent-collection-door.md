# 0011. The order identifier is the agent's proof

Date: 2026-08-27
Status: accepted; for a public audience since 2026-10-19, when the order
identifier left the payment requirements (the product owner)

## Context

An agent that buys an asynchronous product receives an order before the goods
exist and collects them later from `GET /x402/orders/:order_id/status`, so that
route needs a rule for who may ask. Merchants have keys; buyers deliberately
do not, as registering would undo buying with no prior relationship. The
purchase's payment requirements reach the payment facilitator on every
verification and charge, and the x402 Bazaar (ADR-0012) publishes a listed
resource's requirements with `extra` as the last paying request carried it,
per-request values included, as its public listing showed on 2026-10-19.

## Decision

Knowing the order identifier is the proof, on both channels. Whoever presents
it is answered about that order and no other. The identifier is random and
impractical to guess, and it is given only to the agent that bought, in the
paid purchase's answer and on this route, and to the merchant. It is a key to
one order, not proof of having paid for it, which comes only from the verified
payer.

The payment requirements carry a payment reference in its place,
`accepts[].extra.payment_ref`, random like it and kept with the order. A paid
request is bound to the order whose reference it carries back, and one
carrying another order's is refused before the facilitator is asked. The
reference opens nothing: only the purchase reads it, the status route answers
it as any unknown identifier, and another payer presenting a paid order's
reference is refused. A listing may publish it and nothing follows.

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
contract's description of the order document and the site's `llms.txt` tell
the agent that the identifier is the key to its goods, not to be shared.

## Consequences

Anyone who obtains an identifier through a log, a proxy or an agent's own
store can read that order, though not change it, act as its payer or list
other orders: for a parcel its tracking number and link, whose carrier page
may show the buyer's city or who signed for it (ADR-0033), and for every order
the seller's name and site as our catalog shows them (ADR-0034). A listing is
not such a place, which is what makes the door fit for agents nobody vetted.

## Alternatives rejected

Leaving the route unmounted avoids the weak door but takes money for an
asynchronous product that an agent cannot collect. Giving buyers accounts and
keys turns buying into signing up, while the product exists so that an agent
with a budget can buy without a relationship first. A secret token added to
`status_url`, with the identifier left in the requirements, changes what every
agent and merchant reads to repair what only the payment side carries.

Proving control of the paying address with x402's Sign-In-With-X remains the
long-term direction; not now, as it asks every buyer's client for a second
signature, and which clients can give one is not known.
