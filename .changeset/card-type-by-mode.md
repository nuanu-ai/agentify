---
"@nuanu-ai/agentify-contracts": minor
"@nuanu-ai/agentify": minor
---

`CardInput`, the card a merchant writes for `catalog.publish`, is one shape per
fulfillment mode, so the TypeScript compiler refuses what publishing refuses
between the mode and the other fields. A card delivered to the agent, `"sync"`
or `"async"`, must declare `result`, and a parcel's card, `"ship"`, must not; a
parcel must name `ship_within_seconds` and `price_check: "handler"`, and no
other card may name `ship_within_seconds`; only an `"async"` card names
`fulfill_deadline_seconds`; and `"confirm"`, which cannot be published, is not
offered. A card that compiled before and that publishing refused now fails to
compile where it is written. A `Card` read back is not split by mode, so it is
not a `CardInput` as it stands: republish the card your code holds, or assert
the read-back one's type. Publication itself, the zod schemas and the JSON
Schema are unchanged.

The descriptions say what is true about refunds and receipts.
`refund_already_settled` and the `refunded` status mean a refund is recorded
for the order. A refund a merchant sends from their own wallet is not seen and
records nothing, and no refund can be recorded yet, so nothing is answered with
that code today and a late delivery still closes an order owing a refund. A
receipt is written as the goods of a paid purchase are released, on delivery or
when a parcel's shipment is recorded; a paid order whose goods have not come,
one owing a refund, and a charge an operator records by hand have none, so the
receipt list is not an account of the money that came in. `CONTRACT_VERSION`
does not move.
