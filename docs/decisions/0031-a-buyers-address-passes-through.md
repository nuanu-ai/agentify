# 0031. A buyer's address passes through us and is erased once the merchant holds it

Date: 2026-09-28
Status: accepted (Dmitry, 2026-09-28: «мы передаем адрес, но хранить у себя
адрес я не вижу смысла»; the details — «Полностью согласен»). Not built yet.

## Context

A parcel needs an address, and the only thing an agent can hand a merchant
today is the card's `params`: flat fields the merchant declares, checked for
type and nothing else. Whatever arrives there is kept. The gateway writes it
into the order at the unpaid request, so an order that was only priced keeps it
as long as one that was paid; it is copied into every order and price-question
envelope, which the queue keeps for seven days after the merchant draws it; the
nightly backup keeps all of it for thirty days (ADR-0029); nothing deletes an
order. For the address of somebody's home that is a store of personal data no
process of ours reads once the merchant has it.

## Decision

The address has a shape of ours, not the merchant's: a `ship_to` block beside
`params`, asked by a card that ships goods (ADR-0032). Its fields carry the
names of the Agentic Commerce Protocol, which is what an agent already writes —
`name`, `line_one`, `line_two`, `city`, `state`, `postal_code`, `country`,
`phone_number` (`docs/research/37-physical-goods.md`). The country is ISO
3166-1 alpha-2, and the door refuses a block without a name, a first line, a
city and a country, or without a region and a postal code where that country
uses them. The merchant declares no address fields, the agent learns one shape
for every shop, and the gateway knows exactly which values are the address.

The merchant's price check receives only where the parcel goes, not to whom:
`country`, `state`, `city` and `postal_code`. Shipping rates are drawn on those
four, and a destination the merchant does not serve is answered "unavailable"
before money moves. The full block reaches the merchant only in a paid order,
and it is the block that was priced: the paid request cannot change it.

The address stays with us only while the order waits for the merchant to take
it, and is erased at the first of these: the merchant takes the order on, the
merchant records the shipment, the order closes, or the order becomes a refund
owed without having been taken on. Erased means gone from the order and from
every envelope the queue still holds that carried it; reading the order
afterwards says the address was erased, never that there was none. A handler
Agentify runs on a merchant's behalf, such as a shop connector, keeps it no
longer than the gateway does. The address is never written to a log.

Nothing of it is kept — no masked fragment, no fingerprint. A readable fragment
is still personal data and in a small place names a person; the shop software
most merchants run empties even the country and the postal code when it
anonymises an order. A keyed fingerprint, which would answer "is this the same
address", arrives together with the first process that reads it.

## Consequences

The address is ours for seconds, and the personal data we hold does not grow
with sales. Taking an order on now means the merchant has written the address
down: a process that falls over between answering and storing has lost it, and
that order can only be refused into a refund owed. The portal and the SDK say
so where they describe acceptance. An address that did reach a nightly
snapshot stays there until the snapshot expires; nothing rewrites backups. The
price-question envelopes keep the locality for their seven days. The rest of
`params` keeps its present retention. A dispute over where a parcel went cannot
be checked against our records, because we have none.

Rejected: the address in the merchant's own `params` (every shop would name it
differently, and we could not tell what to erase); a delivery token resolved
outside the channel (no agent runtime offers the other end); a masked address
(still personal, and unread); erasing at shipment (days of holding for no
reader); the full address in the price question, as the agent-commerce
protocols do at checkout (a price question goes out for purchases that never
happen, and rates need only the locality); a split first and last name (a
single name cannot be split without guessing, and many people have one).
