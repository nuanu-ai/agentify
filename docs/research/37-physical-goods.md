# Physical goods: what the asynchronous path carries, and what shops do

Date: 2026-09-28. A research note that may be rewritten. It supports ADR-0031
(the buyer's address) and ADR-0032 (a shipped order ends at the carrier), and
it is where their field names come from once they are fixed. The pilot has no merchant who sells
parcels; Dmitry's word of the same day is to lay the foundation anyway, far
enough for a demonstration, because merchants will not come to a path that
does not exist.

## The asynchronous path as it stands

A card that says `fulfillment: 'async'` is sold in this order. The merchant's
price check, when the card has one, is asked before any money moves and
receives the purchase parameters (`apps/docs/examples/quote-request/`); when it
is silent the asynchronous mode does not sell at all
(`packages/core/src/orders/machine.ts`, `sellsOnSilentQuote`). The agent pays,
the gateway verifies and settles the payment inside the purchase request, and
the agent receives `200` with `in_progress` and a `status_url` — with no
deadline, no expected time and no transaction hash. The order goes to the
merchant's subscription; the handler has three seconds to answer
(`HANDLER_ANSWER_MS`) before the delivery counts as lost and is repeated, up to
five attempts. The handler takes the order on with `accepted`, whose
`eta_seconds` the gateway discards (`apps/gateway/src/app/gateway.ts`,
`#takeOrderOn`). Later `order.deliver(result)` closes the order as `delivered`
and writes the receipt, dated back to the charge. A second `deliver` answers
success and keeps nothing.

The clock is `async_fulfillment`, counted from the charge
(`packages/core/src/orders/deadlines.ts`). The card may name it as
`fulfill_deadline_seconds`, a positive integer with no ceiling; a card that
does not is held to a day the agent is never shown. When the clock runs out,
or the merchant refuses after the charge, the order becomes `refund_due` and
the merchant is sent one event, which is never sent again. Goods delivered
late settle the debt (ADR-0028). The command that would record a refund is not
built, so nothing reaches `refunded`. The agent learns any of this only by
polling `status_url`, where holding the order identifier is the proof
(ADR-0011).

The confirmation mode, where the money moves only after the merchant's yes, is
complete inside the machine and closed at the card door and in the gateway's
executor (ADR-0007). Its agent side — how the agent is told it may now pay — is
not designed.

## Where a parcel does not fit

The machine itself needs almost nothing. What does not fit is everything that
assumes the goods are a flat JSON object that reaches the agent the instant it
is handed over.

The address has nowhere of its own to go. The only carrier is `params`: flat
scalar fields the merchant declares, with no format, length or sensitivity. They
are stored in `orders.record` from the unpaid request on, including orders that
never get paid, copied into every order and price-question envelope, kept by
pg-boss for seven days after an envelope is completed (its queue default,
`deletion_seconds`), and in the nightly backups for thirty days. Nothing deletes
an order. ADR-0031 answers this.

`delivered` claims more than a merchant who shipped can know. It means the goods
are with the agent; for a parcel the merchant knows only that a carrier took it.
The call that records goods is once only, so a tracking update after it is
silently ignored, and there is no path from `delivered` back to a debt for a
parcel lost on the way. ADR-0032 answers this.

The money back is decided and not built. ADR-0028 chose that late goods settle
a debt until a refund is recorded, and none of its three pieces exists: the
operator's command, the operator's pause, the merchant's view of the payer's
address. For digital goods a refund owed is rare; for parcels it is an ordinary
ending (the stock the shop system showed was not on the shelf). This is why a
`ship` card stays off the live channel until the command exists.

The rest is smaller. The three-second answer budget is not named on the portal,
and a handler that books a courier inside it spends its five attempts in about
a minute; the answer is to take the order on at once and work outside the
handler, which the demonstration merchant already does. A card is one item at
one price: no quantity, no variants, no line for shipping, so the shipping cost
is part of the price the price check answers. The price check's "unavailable"
carries no reason, so "we do not ship there" and "out of stock" are one bare
`rejected` to the agent. The public card has no shape for the seller's identity
or contact (`packages/contracts/src/card.ts`, the public card's description), so
after shipment the agent would not know whom to ask; the shipment record
carries it.

## How the scope was narrowed

Physical goods were in the first hypothesis — «виртуальные или физические
товары и услуги» (`01-hypothesis.md`) — and the first merchant contract offered
three ways to hand over goods: the merchant's API, a paid order in the
merchant's shop, a message the merchant confirms by hand
(`05-merchant-contract.md`). Freeland was chosen as the pilot precisely because
it has «ни логистики, ни склада» (`03-freeland-pilot.md`). The adversarial
review of the vision found that a physical product has no address mechanics at
all (`09-adversarial-review.md`); the second vision moved physical goods behind
«механики адреса» and sketched the delivery token that ADR-0031 rejects
(`08-product-vision-stories.md`). The open question stayed open
(`00-open-questions.md`) until ADR-0031. The WooCommerce connector imports only
virtual, downloadable products and refuses the rest with «Only virtual products
can be delivered to an agent without a shipping address»
(`apps/cabinet/src/woo-catalog.ts`, ADR-0023).

## Open

- The names of the `ship_to` fields and of the shipment record, taken from how
  WooCommerce and the agent-commerce protocols name them; a survey of both is
  under way and lands in this note.
- A reason on the price check's "unavailable", so that "not to this
  destination" and "out of stock" are two answers to the agent.
- The ceiling on the time to ship, and its number.
- Whether the rest of `params` should follow the address's retention.
- How the operator learns that a shipped parcel was lost, once the ADR-0028
  command exists.
