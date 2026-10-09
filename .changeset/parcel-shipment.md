---
"@nuanu-ai/agentify-contracts": minor
"@nuanu-ai/agentify": minor
---

A parcel's shipment (ADR-0033). On a parcel's order the `deliver` call takes a
`ShipmentSchema` document in place of goods: a `carrier`, a `tracking_number`
that is null where the parcel has none and never empty, and optionally a
`tracking_url` on https and an `estimated_delivery` window, all plain text on
one line. Agentify records when it arrived. The same shipment sent again
succeeds, and a different one is refused with the new call error
`shipment_already_recorded`. The order then reads `shipped`, a new word in
`ORDER_STATUSES` and in a receipt's outcome. The agent's status document
carries the shipment as `RecordedShipmentSchema` under `shipment`, and
`ship_by`, the instant the parcel has to be with a carrier by. Both are present
on a parcel's order only. `delivered` stays null there, because nothing reached
the agent.

Publishing a parcel's card asks the merchant for their shop's site and is
refused without it, with the new merchant finding `no_seller_site`. On the live
channel the card is refused with `not_sold_yet` until the refund of a lost
parcel is recorded there. A parcel's discovery listing asks for `ship_to`
beside the parameters and shows a recorded shipment as its output. The SDK
names the `ShipTo` and `Shipment` types for a merchant's code.
