---
"@nuanu-ai/agentify-contracts": minor
---

A card can describe a parcel (ADR-0033): `fulfillment: "ship"`, with
`ship_within_seconds`, the time to hand the parcel to a carrier counted from the
charge, at most thirty days, and a price check answered by the merchant's own
handler, whose answer is the whole price with shipping. Such a card declares no
`result`, so `result` is optional in the schema and still required, by rule, on
every other mode; in TypeScript, `Card["result"]` is optional.

Where a parcel goes is a block of its own (ADR-0032): `ShipToSchema`, in the
Agentic Commerce Protocol's names, `ShipToLocalitySchema`, the place without the
person, `ErasedShipToSchema` and `localityOf(address)`. A purchase request takes
`ship_to`; a price question carries its locality; and an order reads the
locality before it is paid, the whole address once it is, and only
`{ erased_at }` once Agentify has let go of it: the merchant took the order on,
or the order ended or came to owe a refund without them. Two error codes join a purchase's
refusals: `ship_to_does_not_fit`, for an address on a product that is not
shipped or none on one that is, and `ship_to_changed`, for a payment carrying an
address other than the one the purchase was priced for.

No gateway sells a parcel yet: publishing a parcel's card is refused until a
shipment can be recorded. Nothing an installed SDK worker reads changes, so the
contract version stays `"2"`; it moves once, with the shipment, for the whole
mode.
