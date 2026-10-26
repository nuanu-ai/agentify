---
"@nuanu-ai/agentify-contracts": patch
---

The descriptions of a delivery address, `ship_to`, which a buyer's agent reads
in a parcel's purchase schema, and of an erased one, `ship_to: { erased_at }`,
now say what erasing reaches. It removes the address from Agentify's database.
Copies of the database taken before the erasure keep it: the live channel's
backups, usually for about sixty days, with no upper bound set yet, and the
restore point each release takes, on either channel, until five newer releases
replace it. Nothing a call sends or answers changes.
