# 0032. A buyer's address passes through us and is erased once the merchant holds it

Date: 2026-09-28
Status: accepted (the product owner, 2026-09-28, after two rounds of
adversarial review). Built so far: no error leaving the store or the queue
carries a bound parameter. The address itself is not built yet.

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

A card that ships (ADR-0033) takes a `ship_to` block beside `params`, in a
shape of ours with the Agentic Commerce Protocol's names: `name`, `line_one`,
`line_two`, `city`, `state`, `postal_code`, `country`, `phone_number`. Any other
card refuses it. The door checks the shape: a name, a first line, a city and a
phone are present, the country is two capital letters (ISO 3166-1 alpha-2),
and a `state`, where given, is a subdivision code without the country's
prefix. Whether a state or a postal code is needed, and whether the merchant
ships there, is the merchant's to answer.

The merchant's price check receives where the parcel goes, not to whom: a
`ship_to` holding only `country`, `state`, `city` and `postal_code`. The full
block reaches the merchant only for a paid order, in the order and in their
reads of it. It is the block that was priced: a paid request carrying another
is refused before the payment is verified, with words to start a new purchase,
and one carrying none pays for the block that was priced.

A merchant takes an order on by answering `accepted`, from the handler or by
the `accept` call, and the merchant stores `ship_to` before either: that answer
erases our copy. We hold the address from the priced request until the first of
these: the order is taken on, its shipment is recorded, it closes, or it
becomes a refund owed without having been taken on. Then it leaves the order,
and every envelope carrying any of the address — the order's hand-overs and its
price questions — is deleted from the queue; the events about the order, the
refund-owed notice among them, carry no address and are kept, as are the
reminders that keep its deadlines. The order then reads `ship_to: {
"erased_at": … }`, never absent, and is never handed to a handler again.
Nothing of the address is kept, neither a masked fragment nor a fingerprint,
and nothing of ours logs it: no error leaving the store or the queue carries a
bound parameter. A handler Agentify runs for a merchant, such as a shop
connector, keeps it no longer than the gateway does.

## Consequences

The address is ours while an order waits for its merchant: seconds while their
worker runs, at most the time to ship while it does not. A merchant process
that falls over between receiving an order and storing its address loses it,
the order can only be refused into a refund owed, and a late parcel on an
order never taken on must come from the merchant's own copy. The portal's
asynchronous pattern, which keeps only our identifier, and its walk over
`orders.list` after a restart change for parcels. What merchants write as free
text is theirs, and the portal asks them to keep the address out of it. A
snapshot keeps what it caught until it expires. A dispute over where a parcel
went cannot be checked against us. The rest of `params` keeps its present
retention.

Rejected: the address in merchant-declared `params` (no common shape, and no
telling what to erase); a delivery token resolved outside the channel (no agent
runtime offers the other end); a masked address or a fingerprint (still
personal — WooCommerce keeps not even the country when it anonymises — and
nobody reads it; a fingerprint comes with the first process that does); erasing
at shipment (days of holding so that a merchant can read back what they did not
store); the full address in the price question, as the protocols do at checkout
(it would reach merchants for purchases never made, and rates need only the
locality); a split first and last name (one name cannot be split without
guessing); a per-country table of required fields (the merchant knows what
their carrier needs).
