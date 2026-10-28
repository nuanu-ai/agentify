# 0032. A buyer's address passes through us and is erased once the merchant holds it

Date: 2026-09-28
Status: accepted (the product owner, 2026-09-28, after two rounds of
adversarial review). Since prices travel with the buyer (ADR-0049), the full
address arrives with the payment rather than with the price.

## Context

A parcel needs an address, and a card's `params` are fields the merchant
declares, checked for type alone, kept with the order for good, copied into
every queue envelope and dumped with the database every ten minutes into
snapshots kept for weeks (ADR-0029). For somebody's home address that is a
store of personal data no process of ours reads once the merchant has it. The
survey behind this decision is [research 37](../research/37-physical-goods.md).

## Decision

A card that ships (ADR-0033) takes a `ship_to` block beside `params`, in a shape
of ours with the Agentic Commerce Protocol's names: `name`, `line_one`,
`line_two`, `city`, `state`, `postal_code`, `country`, `phone_number`. Any other
card refuses it. The door checks that a name, a first line, a city and a phone
are present, that the country is two capital letters (ISO 3166-1 alpha-2) and
that a `state`, where given, is a subdivision code without the country's
prefix. Whether a state or a postal code is needed, and whether the merchant
ships there, is the merchant's to answer.

The merchant's price check receives where the parcel goes, not to whom: only
`country`, `state`, `city` and `postal_code`, and nothing of it is stored. The
price's stamp binds a keyed digest of that locality (ADR-0049). The paid request
repeats the full block; one carrying none is refused, and one whose locality is
not the priced one is refused after its payment verifies, with words to start a
new purchase for that address, so a published stamp cannot test guesses about
where somebody lives. The first verified payment writes the full block with
the order it admits, and the merchant sees it only on such an order.

The merchant takes an order on by answering `accepted`, from the handler or by
the `accept` call, and stores `ship_to` before either. We hold the address until
the first of these: the order is taken on, its shipment is recorded, it closes,
or it enters `unfulfilled` without having been taken on (ADR-0028). Then it
leaves the order and every queue envelope carrying it is deleted; the events
about the order, `order.unfulfilled` among them, carry no address and are kept,
as are the reminders of its deadlines. The order then reads
`ship_to: { "erased_at": … }`, never absent, and is never handed to a handler
again. Nothing of the address is kept, neither a masked fragment nor a
fingerprint, and nothing of ours logs it: no error leaving the store or the
queue carries a bound parameter. The kept stamp holds only its keyed locality
digest. A shop connector keeps the address no longer than the gateway does; the
shop's own guest carts may keep the last priced locality until WooCommerce
expires them (ADR-0023). The erasure reaches the channel's database. Copies
taken before it keep the address: the live channel's backups, usually for about
sixty days with no upper bound set (ADR-0029), and the restore point each
release takes on either channel, until five newer releases replace it. The
portal and the contract say so wherever they promise the erasure.

## Consequences

The address is ours while an order waits for its merchant: seconds while their
worker runs, at most the time to ship while it does not. A merchant process
that falls over between receiving an order and storing its address loses it,
the order can only end unfulfilled, and a late parcel on an order never taken
on must come from the merchant's own copy. For parcels the portal's
asynchronous pattern, which keeps only our identifier, and its walk over
`orders.list` after a restart change. What merchants write as free text is
theirs, and the portal asks them to keep the address out of it and out of
`params`, which stay with their order. A dispute over where a parcel went
cannot be checked against us.

Rejected: the address in merchant-declared `params` (no common shape, and no
telling what to erase); a delivery token resolved outside the channel (no agent
runtime offers the other end); a masked address or a fingerprint (still
personal, since WooCommerce keeps not even the country when it anonymises, and
nobody reads it); erasing at shipment (days of holding so a merchant can read
back what they did not store); the full address in the price question, as the
protocols do at checkout (it would reach merchants for purchases never made,
and rates need only the locality); a split first and last name (one name cannot
be split without guessing); a per-country table of required fields (the
merchant knows what their carrier needs).
