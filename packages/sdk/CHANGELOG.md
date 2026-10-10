# Merchant SDK release history

## 0.5.0

### Minor Changes

- 4f9bab1: An acceptance carries nothing. `eta_seconds` is gone from `AcceptanceSchema`,
  from `order.accepted()` and `accept()` in the SDK, and from the `Acceptance`
  type the SDK re-exported, because nothing kept the number and no agent saw it.
  A body that still names it is refused with words saying it was removed and to
  answer `accepted()` with nothing in it. A worker on an earlier SDK that sent it
  has to move to this one.
- b5a4c4f: A card's `price_check` is `"handler"` and nothing else. The `{ url }` form,
  a price hook at an address of the merchant's own, is gone from
  `PriceCheckSchema`, from the `Card` type and from the JSON Schema export,
  because the gateway never calls such an address: a card that named one was
  accepted and then priced as though the merchant had not answered, so a
  synchronous product quietly sold at its listed price and an asynchronous one
  quietly refused every sale. Publishing such a card, and `checkCard` on it,
  now refuse it with a finding at `price_check` that says the price is asked
  of the merchant's own price handler. The price hook stays designed and
  uncalled; `CONTRACT_VERSION` does not move, because nothing a worker reads
  changes.
- 4f9bab1: `agentify verify` answers `0` when every card it was given is complete as far
  as the contract can tell, `1` when a card has findings and `2` when it was
  called with something it cannot work from, the bare command included. It no
  longer counts a handler's idempotency as a check that "could not be run" and
  answers `3` for a complete card, which a build read as a failure: whether a
  handler holds against an order delivered twice is not something a command
  holding only card files can try, and the output says so and that a test
  purchase proves it.

### Patch Changes

- 4f9bab1: zod is required at exactly the version the gateway runs, 4.4.3, rather than by
  a range. A merchant's install could take a newer zod that counts a string's
  length differently, and then the SDK's offline card check passed a card that
  publication refused (an emoji in a description of 500 counted once, not twice).
  The two are one check again.
- Updated dependencies [4f9bab1]
- Updated dependencies [4f9bab1]
- Updated dependencies [b5a4c4f]
- Updated dependencies [4f9bab1]
- Updated dependencies [4f9bab1]
- Updated dependencies [b5a4c4f]
- Updated dependencies [4f9bab1]
  - @nuanu-ai/agentify-contracts@0.9.0

## 0.4.0

### Minor Changes

- 5412b71: A parcel's shipment (ADR-0033). On a parcel's order the `deliver` call takes a
  `ShipmentSchema` document in place of goods: a `carrier`, a `tracking_number`
  that is null where the parcel has none and never empty, and optionally a
  `tracking_url`, an https address on a domain name and nothing else, and an
  `estimated_delivery` window; its words are plain text on one line. What a
  delivery is checked against comes from the order, so a card republished since
  the sale changes nothing for it. Agentify records the instant the call arrived
  as when the parcel shipped. The same shipment sent again succeeds, and a
  different one is refused with the new call error `shipment_already_recorded`. The order then reads `shipped`, a new word in
  `ORDER_STATUSES` and in a receipt's outcome. The agent's status document
  carries the shipment as `RecordedShipmentSchema` under `shipment`, and
  `ship_by`, the instant the parcel has to be with a carrier by. Both are present
  on a parcel's order only. `delivered` stays null there, because nothing reached
  the agent.
  
  Publishing a parcel's card asks the merchant for their shop's site and is
  refused without it, with the new merchant finding `no_seller_site`. On the live
  channel the card is refused with `not_sold_yet` until the refund of a lost
  parcel is recorded there. A parcel's discovery listing asks for `ship_to`
  beside the parameters and shows a recorded shipment as its output. The SDK
  names the `ShipTo` and `Shipment` types for a merchant's code, and its README
  says that during the pilot the contract version does not move with every
  change, so a package older than the gateway can read a newer word as a
  failure.

### Patch Changes

- Updated dependencies [436e368]
- Updated dependencies [d483a58]
- Updated dependencies [f17084b]
- Updated dependencies [5412b71]
  - @nuanu-ai/agentify-contracts@0.8.0

## 0.3.1

### Patch Changes

- Updated dependencies [6f8521e]
- Updated dependencies [effa6e3]
- Updated dependencies [3862afa]
- Updated dependencies [685b465]
  - @nuanu-ai/agentify-contracts@0.7.0

## 0.3.0

### Minor Changes

- 3b8b274: `checkCard` now applies the contract's price rule after the card's shape
  passes, so it finds what publishing refuses about a price: zero, an amount
  written with fewer than two or more than six digits after the dot, and a
  currency other than USD or USDC. Each comes back as a finding on
  `price.amount` or `price.currency`, in the words the publish call uses. A card priced `'5 USD'`
  that passed the check before is now reported, because the gateway refuses it.
  
  The worker holds a price handler's answer to the same rule before sending it,
  and reports one that breaks it as `HANDLER_ANSWER_REFUSED` naming the field,
  as it already did for an answer the schema refuses.
- 0dac361: `MERCHANT_FINDINGS` and the `MerchantFinding` type name the three findings a
  refused publish carries about the merchant rather than the card:
  `no_seller_name`, `no_payout_wallet` and `no_operator_approval`. The gateway
  already sent these codes, each with an empty path in the error's `problems`;
  the constants let a program tell "fix the card" from "fix the merchant"
  without spelling the words itself. The SDK re-exports both beside
  `CARD_REJECTED`. The exported JSON Schema of a finding now describes its
  `code` and names the three, and the description of a refusal's `problems`
  says that its `message` names the merchant's missing settings plainly rather
  than quoting the first finding. The description of a merchant's card list
  now counts the live approval among the reasons a card reads paused, which it
  already was. Nothing on the wire changes shape, so the contract version stays
  where it is.

### Patch Changes

- Updated dependencies [dcf7ec1]
- Updated dependencies [0dac361]
- Updated dependencies [350d222]
  - @nuanu-ai/agentify-contracts@0.6.0

## 0.2.8

### Patch Changes

- Updated dependencies [ae15921]
- Updated dependencies [b2de0fe]
- Updated dependencies [4a4f100]
- Updated dependencies [97529a5]
  - @nuanu-ai/agentify-contracts@0.5.0

## 0.2.7

### Patch Changes

- Updated dependencies [8394f96]
- Updated dependencies [8550654]
  - @nuanu-ai/agentify-contracts@0.4.0

## 0.2.6

### Patch Changes

- e37eabc: The package page names every page of the merchant documentation. It used to
  say the portal had four pages and left out the three written for the owner —
  connecting, money and the common questions. Nothing in the code changes.

## 0.2.5

### Patch Changes

- Use https://agentify.ad for the production gateway and documentation in SDK guidance. The gateway address remains explicit; request, payment and contract behavior is unchanged.

## 0.2.4

### Patch Changes

- d1f6870: Publish the merchant SDK, contracts package and `agentify` command under their Agentify names. The wire contract and runtime behavior are unchanged.
- Updated dependencies [35941c2]
- Updated dependencies [d1f6870]
- Updated dependencies [c7c26b8]
  - @nuanu-ai/agentify-contracts@0.3.2

These entries record releases published under the former package names.
Version numbers and release facts are retained; former package and command
identities are described generically. The original wording remains in Git history.

## 0.2.3

### Patch Changes

- Updated dependencies [99c959c]
  - Original contracts package, version 0.3.1

## 0.2.2

### Patch Changes

- 38257b3: Carry a merchant's refusal to the agent. The status document an agent reads
  back for its own purchase grows an optional `refusal`, holding the two words
  the merchant's handler actually answered with — the short code it branches on
  and the sentence it can show a person — in the same shape the handler sends
  them in. It is present wherever a merchant's refusal is what closed the order,
  whichever word the order ended under, and absent everywhere else: an ending
  nobody worded arrives with no pair rather than with an invented one.

  `CONTRACT_VERSION` does not move. It is the handshake between a merchant's
  installed SDK and the gateway, and no SDK reads this document — it travels only
  on the agent's storefront, which carries no version by ADR-0006 §5. Nothing in
  the SDK's own surface changes; its bump is the dependency's.

- 3d815e9: License both public packages under Apache-2.0 and include the Nuanu AI
  attribution notice in their npm archives.
- Updated dependencies [38257b3]
- Updated dependencies [3d815e9]
  - Original contracts package, version 0.3.0

## 0.2.1

### Patch Changes

- The package pages on npm say what the packages are. Nothing in the code
  changes: the README of each package is rewritten for somebody meeting the product
  on the registry — what the merchant SDK sells and the two addresses it can be
  pointed at, and why the contracts package exists and who installs it directly —
  and both manifests gain a description written for the same reader, keywords,
  and a link to the documentation.
- Updated dependencies
  - Original contracts package, version 0.2.1

## 0.2.0

### Minor Changes

- 040ca4e: One answer envelope for every merchant-facing call, and one word for findings.
  This changes the wire, and code written against the previous release has to be
  updated.

  `catalog.publish` now answers `{ ok: true, id }` or `{ ok: false, error }`,
  where `ok` is a boolean like it already was on the order calls and the catalog
  identifier sits beside it rather than nested. A refused card comes back under
  the code `card_rejected`, never retryable, with every finding in
  `error.problems` — the same list `checkCard` has always returned. Read it as
  `if (!published.ok) console.error(published.error.problems)`; `'errors' in
published` and `published.errors` are gone.

  An error may now carry `problems` on any call, which is how a delivery that
  does not match its card names the fields that did not fit.

  Renamed: the type `PublishError` is `Problem`, and `OrderCallError` is
  `CallError` — it is no longer only the order calls' error. `CARD_REJECTED` is
  exported for the code above.

  A call with no failure branch of its own — publishing, `orders.get`,
  `orders.list` — now throws the SDK's named error class with `code`, `route` and `retryable`
  instead of a bare `Error`, under the same codes the order calls return. A client
  built wrong is still a `TypeError`.

  Every refusal the gateway sends now carries `retryable` beside its code and its
  sentence, answering whether making the same call again could succeed. It is
  assigned conservatively — true only where repeating the call is itself the way
  through — and it is what the SDK reports for a call the gateway refused in
  words, in place of the blanket `true` it used to claim.

  The verify command's internals (`runVerify`, `VERIFY_EXIT`, `NOT_JSON`,
  `IDEMPOTENCY_IS_NOT_BUILDABLE`, `Say`) are no longer exported. Run the installed verification command; `checkCard` is what integration code calls.

  `CONTRACT_VERSION` is `"2"`. A worker on the previous version stops at its
  handshake against a gateway speaking this one, which is what that handshake is
  for.

### Patch Changes

- Updated dependencies [040ca4e]
  - Original contracts package, version 0.2.0

## 0.1.0

### Minor Changes

- Publish the first installable merchant SDK and its contract schemas.

### Patch Changes

- Updated dependencies
  - Original contracts package, version 0.1.0
