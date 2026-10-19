# 0011. The order identifier is the agent's proof

Date: 2026-08-27
Status: accepted for the controlled launch; not fit for a public audience
until the condition under Consequences holds

## Context

An agent that buys an asynchronous product receives an order before the goods
exist and collects them later from `GET /x402/orders/:order_id/status`, so that
route needs a rule for who may ask. Merchants have keys; buyers deliberately
do not, as registering would undo buying with no prior relationship.

## Decision

Knowing the order identifier is the proof, on both channels. Whoever presents
it is answered about that order and no other. The identifier is random and
impractical to guess. Agentify, the merchant and the payment facilitator hold
it too: every payment request carries it in `accepts[].extra.order_id`, and
the facilitator receives it with each payment it verifies and settles. It is a
key to one order, not proof of having paid for it, which comes only from the
verified payer.

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

Anyone who obtains an identifier can read that order, though not change it,
act as its payer or list other orders. For a parcel that includes its tracking
number and link, whose carrier page may show the buyer's city or who signed for
it (ADR-0033), and for every order the seller's name and site as our catalog
shows them (ADR-0034).

The product owner accepted this bearer risk for the controlled launch, which
had no external users. It does not carry to a public audience, because a
listing can publish identifiers. The x402 Bazaar (ADR-0012) publishes a listed
resource's payment requirements with `extra` as the last paying request carried
it, per-request values included, as its public listing showed on 2026-10-19;
once an Agentify resource is listed there, some buyer's order identifier can be
public. No Agentify resource was listed that day. Before the first one is, the
status route must ask for something a listing never carries, and this record
says what. Parcels on the live channel wait for that too (ADR-0033).

## Alternatives rejected

Leaving the route unmounted avoids the weak door but takes money for an
asynchronous product that an agent cannot collect. Giving buyers accounts and
keys turns buying into signing up, while the product exists so that an agent
with a budget can buy without a relationship first.

Proving control of the paying address with x402's Sign-In-With-X remains the
long-term direction; not now, as it asks every buyer's client for a second
signature, and which clients can give one is not known.
