# 0031. A buyer's address passes through us and is erased once the merchant holds it

Date: 2026-09-28
Status: accepted (Dmitry, 2026-09-28: «мы передаем адрес, но хранить у себя
адрес я не вижу смысла»); the revisions of two review rounds await his word.
Not built yet.

## Context

A parcel needs an address, and the only thing an agent hands a merchant today
is the card's `params`: fields the merchant declares, checked for type alone.
They are written into the order at the unpaid request and readable by the
merchant from then on, copied into every envelope the queue keeps for a week,
dumped with the database every ten minutes into snapshots kept for weeks
(ADR-0029), and carried whole in a failed statement's error, which most paths
log. Nothing deletes an order. For somebody's home address that is a store of
personal data no process of ours reads once the merchant has it. The survey
behind this decision is `docs/research/37-physical-goods.md`.

## Decision

A card that ships (ADR-0032) asks for a `ship_to` block beside `params`, in a
shape of ours with the Agentic Commerce Protocol's names: `name`, `line_one`,
`line_two`, `city`, `state`, `postal_code`, `country`, `phone_number`. Any other
card refuses it. The door checks the shape — a name, a first line, a city and a
phone, a country in ISO 3166-1 alpha-2, a subdivision code for the state where
the country has one — and leaves the geography to the merchant.

The merchant's price check receives where the parcel goes, not to whom:
`country`, `state`, `city`, `postal_code`. The full block reaches the merchant
only for a paid order, in the order and in their reads of it. It is the block
that was priced: a paid request carrying another is refused before the payment
is verified, and one carrying none pays for the block that was priced.

We hold the address from the priced request until the first of these: the
merchant takes the order on, records the shipment, the order closes, or it
becomes a refund owed without having been taken on. Then it leaves the order,
every envelope of the order is deleted from the queue (the messages to the
merchant, not the reminders that keep its deadlines), and the order reads
`ship_to: { "erased_at": … }`, never absent, and is never handed to a handler
again. Nothing of it is kept — neither a masked fragment nor a fingerprint —
and no log or error carries it. A handler Agentify runs for a merchant, such as
a shop connector, holds it no longer.

## Consequences

The address is ours while an order waits for its merchant: seconds while their
worker runs, at most the time to ship while it does not. Taking an order on
means the merchant has stored the address; a process that falls over in
between loses it, the order can only be refused into a refund owed, and a late
parcel on a debt never taken on must come from the merchant's own copy. The
portal's asynchronous pattern and its restart walk change for parcels. What
merchants write as free text is theirs, and the portal asks them to keep the
address out of it. A snapshot keeps what it caught until it expires. A dispute
over where a parcel went cannot be checked against us. The rest of `params`
keeps its present retention.

Rejected: the address in merchant-declared `params` (no common shape, and no
telling what to erase); a delivery token resolved outside the channel (no agent
runtime offers the other end); a masked address or a fingerprint (still
personal — WooCommerce keeps not even the country when it anonymises — and
nobody reads it); erasing at shipment (days of holding so that a merchant can
read back what they did not store); the full address in the price question, as
the protocols do at checkout (it would reach merchants for purchases never
made, and rates need only the locality); a split first and last name (one name
cannot be split without guessing); a per-country table of required fields (the
merchant knows what their carrier needs).
