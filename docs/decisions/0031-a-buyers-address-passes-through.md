# 0031. A buyer's address passes through us and is erased once the merchant holds it

Date: 2026-09-28
Status: accepted (Dmitry, 2026-09-28: «мы передаем адрес, но хранить у себя
адрес я не вижу смысла»; the details below — «Полностью согласен»). Not built
yet.

## Context

A parcel needs an address, and the only thing an agent can hand a merchant
today is the card's `params`: flat fields the merchant declares, checked for
type and nothing else. Whatever arrives there is kept. The gateway writes it
into the order at the unpaid request, before any money moves, so an order that
was only priced keeps it as long as one that was paid. It is copied into every
order and price-question envelope, and the queue keeps an envelope for seven
days after the merchant has drawn it. The nightly backup keeps all of it for
thirty days (ADR-0029), and nothing ever deletes an order. For the address of
somebody's home that is a store of personal data no process of ours reads once
the merchant has it. The vision proposed a delivery token resolved outside the
channel (`docs/research/08-product-vision-stories.md`); nothing on the agent's
side can produce one.

## Decision

The address has a shape of ours, not the merchant's. A card that ships goods
(ADR-0032) takes a `ship_to` block beside `params`, in the purchase request and
in the order, with fields named the way shops already name them
(`docs/research/37-physical-goods.md`). The merchant declares no address
fields, the agent learns one shape for every shop, and the gateway knows
exactly which values are the address.

The merchant's price check receives only the country and the postal code of
`ship_to`: enough to price the shipping, and to answer "unavailable" for a
destination the merchant does not serve before any money moves. The full block
reaches the merchant only in a paid order.

The address stays with us only while the order waits for the merchant to take
it. It is erased at the first of these: the merchant takes the order on (the
handler's acceptance or the `accept` call), the merchant records the shipment,
the order closes, or the order becomes a refund owed without having been taken
on. Erased means gone from the order and from every envelope the queue still
holds that carried it. Reading the order afterwards says the address was
erased, never that there was none.

Nothing of the address is kept: no masked fragment and no fingerprint. A
readable fragment is still personal data, and in a small place it names a
person. A keyed fingerprint, which would answer "is this the same address",
arrives together with the first process that reads it — a dispute or a support
command — because a field nobody reads is a field kept just in case.

Taking an order on means the merchant has written the address down. It cannot
be read back from us afterwards, and the portal and the SDK say so where they
describe acceptance. The address is never written to a log.

## Consequences

The address is ours for seconds, and the personal data we hold does not grow
with sales. A merchant whose process falls over between answering `accepted`
and storing the address has lost it for good; that order can only be refused,
which makes it a refund owed. That is the price of holding nothing. An address
erased seconds after payment rarely reaches a nightly snapshot; one that did
stays there until the snapshot expires, and nothing rewrites backups. The
price-question envelopes keep the country and the postal code for their seven
days. The rest of `params`, such as the email the eSIM card asks for, keeps its
present retention; this decision does not touch it.

Rejected:
- The address in the merchant's own `params`. Every merchant would name the
  fields differently, agents could learn no single shape, and the gateway could
  not tell which values to erase.
- A delivery token resolved outside the channel. It needs a service on the
  buyer's side that no agent runtime offers.
- A masked address kept for recognition. It is still personal data, and it has
  no reader.
- Erasing at shipment rather than at acceptance. The address would sit with us
  through days of handling for no reader.
- The full address in the price question. It would reach merchants for
  purchases that never happen.
