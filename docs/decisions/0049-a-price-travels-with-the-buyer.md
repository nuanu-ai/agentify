# A price travels with the buyer, and an order is born at its verified payment

Status: the product owner chose on 2026-10-27 a price that travels with the
buyer under Agentify's stamp, an order written only once a payment verifies,
the term judged by when the paid request arrives, a generic `quote_reference`
the buyer can read, no support kept for the old `extra.order_id`, and the stamp
in `extra`, where x402 sellers put their own data. On 2026-10-28 the product
owner decided that a change of the seller's site address voids no price already
given. How a payment is admitted, the exit trigger and the listed-example rule
are engineering choices. The mechanics and every alternative with its source
are in [research 90](../research/90-unpaid-price-questions-design.md).

## Context

An unpaid purchase used to write an order before its price was asked, so anyone
could fill the database, the merchant's queue and the order figures without
paying (ADR-0043). A price must still hold for its stated term, and one price
must never become two purchases.

## Decision

An unpaid request writes nothing. Its 402 carries the ordinary x402 amount,
asset and payee and an opaque `extra.price_stamp`: an HMAC-SHA256 under a
channel secret over every fact the price rests on, with the parameters and a
parcel's locality only as keyed digests. It holds no buyer key and no full
address, so the paid request repeats the purchase body. A price question lives
only while its caller waits. Contract version 6 removes `extra.order_id` and
the ending reasons `unavailable`, `price_check_unanswered` and `price_expired`.

The stamp is authenticated before any gate is entered; one that does not
authenticate is taken only as the byte-for-byte saved price of an existing
order, so a paid return outlives a retired signing key. A price holds for three
minutes, "at least three minutes" in the product owner's word of 2026-10-28,
because an agent may show the price to a person; the term is judged by when the
complete paid request arrives. One price names one order.

Inside the gateway process one request per price is checked at a time; another
gets a retryable `payment_not_taken` with `Retry-After: 2` that neither says
nothing was charged nor suggests buying again. Verification holds no database
connection. A verified payment is admitted in one short transaction with a
two-second lock timeout, which locks the price, finds no order, holds the
merchant's row and the card, checks that the card's terms, payee, selling
switch, integration and, for a card paid before delivery, the seller's site
still stand, records the authorization's nonce against this order alone, and
writes the order, its jobs and its analytics together. A lock not granted in
time answers busy before any write. The charge runs after commit. The exit
trigger is a second gateway process on a channel: the in-memory guard does not
cross processes, and while the admission still makes one order of one price,
both processes would verify the same payment.

A price depends on the card's terms, policy, integration and payee, not on when
the card was published, so republishing it unchanged keeps outstanding prices.
A changed seller site voids none either: "выданная цена остается в силе" (the
price given stays in force), in the product owner's word of 2026-10-28. A
changed term or payee answers `payment_not_taken`, not retryable; a card off
sale or a switched integration answers `not_selling` and says nothing was
charged. Parameters or a locality other than the stamped ones are refused only
after the payment verifies, so a published stamp cannot test guesses about
them.

A payment signed for the listing, with no stamp, gets a fresh priced 402 and
nothing is verified or charged. A body equal to the card's own listed example,
where the card declares parameters or is a parcel, is answered as the listing
without asking the merchant, because Coinbase's catalogue replays that example
after payments settled through its facilitator. A merchant's `quote_reference`,
up to 512 printable characters, is stamped and returned unchanged on the order;
the buyer reads it, so it holds no secret and no personal data. A paid purchase
comes back for the exact saved stamp and a fresh signature from the wallet that
paid, never for the spent authorization.

## Alternatives rejected

Asking the merchant again at payment, as x402's reference server does, doubts
the stated term, asks twice per sale and refuses a buyer who has signed.
Storing the order before payment, as Crossmint's demo seller and the Agentic
Commerce Protocol's checkout do, lets anyone fill for free what is stored for
free, and its thirty-day deletion goes with it. A price check when the order
reaches the merchant stores every free answer there and, for a card paid
first, comes after the money moved, where ten such refusals stop the
merchant's sales (ADR-0046). Every price from the card
serves fixed prices only. A limit per wallet before payment has no wallet to
count. `extensions` instead of `extra`: x402 v2 reserves `extra` for the
scheme, but sellers use it and agents treat the value as opaque. A key the
buyer's client keeps adds a duty to every buyer; an agent that wants to
recover a lost answer keeps the 402 instead (ADR-0011).
