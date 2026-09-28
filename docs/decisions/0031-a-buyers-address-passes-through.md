# 0031. A buyer's address passes through us and is erased once the merchant holds it

Date: 2026-09-28
Status: accepted (Dmitry, 2026-09-28: «мы передаем адрес, но хранить у себя
адрес я не вижу смысла»; the details — «Полностью согласен»), revised the same
day after an adversarial review. Not built yet.

## Context

A parcel needs an address, and the only thing an agent can hand a merchant
today is the card's `params`: flat fields the merchant declares, checked for
type and nothing else, and kept. The gateway writes them into the order at the
unpaid request, so an order that was only priced keeps them as long as one that
was paid, and the merchant can read them back on either. They are copied into
every order and price-question envelope, which the queue keeps for seven days
after the merchant draws it, and into a dump of the database every ten minutes
whose snapshots live up to thirty days, their deleted copies thirty more
(ADR-0029). A database driver's error carries every bound parameter of the
statement, and most paths that fail log the error whole. Nothing deletes an
order. For the address of somebody's home that is a store of personal data no
process of ours reads once the merchant has it.

## Decision

The address has a shape of ours: a `ship_to` block beside `params`, asked only
by a card that ships (ADR-0032) and refused on any other. It takes the Agentic
Commerce Protocol's names — `name`, `line_one`, `line_two`, `city`, `state`,
`postal_code`, `country`, `phone_number` (`docs/research/37-physical-goods.md`).
The door checks the shape and not the geography: a name, a first line, a city
and a phone number are present, the country is two capital letters (ISO
3166-1), and `state` is the subdivision code without the country's prefix
where the country has one. Whether the merchant ships there, and whether the
region and the postal code are enough, is theirs to answer before money moves.

The merchant's price check receives where the parcel goes and not to whom:
`country`, `state`, `city`, `postal_code`. The full block reaches the merchant
only in a paid order, and only a paid order shows it on the merchant's reads.
It is the block that was priced: a paid request carrying a different one is
refused before the payment is verified, with words saying to start again.

The address stays with us while the order waits for the merchant to take it —
seconds while their worker runs, up to the time to ship while it does not — and
is erased at the first of these: the merchant takes the order on, records the
shipment, the order closes, or it becomes a refund owed without having been
taken on. Erasing deletes every envelope of that order the queue holds,
waiting, drawn or failed, and removes the block from the order, whose
`ship_to` then reads `{ "erased_at": … }` — never absent. No error that leaves
the store or the queue carries a bound parameter, and nothing logs the
address. A handler Agentify runs for a merchant, such as a shop connector,
keeps it no longer than the gateway does.

Nothing of the address is kept, neither a masked fragment nor a fingerprint. A
readable fragment is still personal data and in a small place names a person;
the shop software most merchants run empties even the country and the postal
code when it anonymises an order. A keyed fingerprint, which would answer "is
this the same address", arrives with the first process that reads it.

## Consequences

Taking an order on means the merchant has stored the address: their handler
holds it and writes it down before answering. A process that falls over in
between has lost it, and that order can only be refused into a refund owed; a
late parcel on a refund owed they never took on can come only from their own
copy. The portal's async pattern of keeping just the order's identifier, and
its restart walk over `orders.list`, change for parcels. What reached a
snapshot stays until the snapshot expires. Whatever the merchant writes as free
text — a refusal's message, a tracking address — is theirs, and the portal asks
them to keep the address out of it. The rest of `params` keeps its present
retention. A dispute over where a parcel went cannot be checked against us.

Rejected: the address in the merchant's `params` (every shop would name it
differently, and we could not tell what to erase); a delivery token resolved
outside the channel (no agent runtime offers the other end); a masked address
(still personal, and unread); erasing at shipment, which would let a merchant
who kept only our identifier read the address back, at the price of holding
every address through days of handling; the full address in the price
question, as the protocols do at checkout (a price question goes out for
purchases that never happen, and rates need only the locality); a split first
and last name (a single name cannot be split without guessing, and many people
have one); a per-country table of required fields at the door (data to keep in
step with the world, where the merchant knows what their carrier needs).
