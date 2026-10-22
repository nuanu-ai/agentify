# Merchant SDK release history

## 0.8.0

### Minor Changes

- bcdd8d8: Handle up to four stream messages concurrently through one poll producer, so a slow order no longer blocks unrelated orders and quotes while capacity is available. Preserve same-order event ordering, coalesce in-flight order redeliveries, and wait for all started handlers during shutdown. Handlers for different orders may now overlap; fulfillment still needs idempotency by order identifier.
- f9a2ce4: The confirmation mode is gone from the contract. `FulfillmentSchema` is
  `sync`, `async` or `ship`, and a card naming `confirm` is refused with the
  ordinary list of modes; the card and the agent's public card have no
  `confirm_deadline_seconds`; the order status `declined` and the event
  `order.unpaid_after_confirmation` (`ORDER_EVENT_TYPES.UNPAID_AFTER_CONFIRMATION`)
  are removed. No card could be published in that mode, so the gateway sent none
  of these values, and a reader built on the previous version reads everything
  it sends today. The SDK re-exports the narrower `Card`, `CardInput`,
  `Fulfillment`, `OrderStatus` and `OrderEvent` types and `ORDER_EVENT_TYPES`
  without that member.
  
  Code that names any of the removed values stops compiling on upgrade:
  `ORDER_EVENT_TYPES.UNPAID_AFTER_CONFIRMATION`, a `case "declined"` on an order
  status, `fulfillment: "confirm"` in a card, and `confirm_deadline_seconds`.
  Such code handled something the gateway never sent, so deleting it changes
  nothing at run time.
- d9bcb7d: A merchant's selling state is `open` or `paused`; `departed` is gone from
  `SellingStateSchema`, because nothing could set a merchant to it. With it go
  the order status `cancelled`, the reason `merchant_left` on `order.unfulfilled`
  and on an unfulfilled order's status, and the error code `merchant_departed`.
  The descriptions of the pause and resume routes no longer speak of a merchant
  who has left. The gateway sent none of these values, so a reader built on the
  previous version reads everything it sends today. The SDK re-exports the
  narrower `OrderStatus` and `OrderEvent` types.
  
  Code that names any of the removed values stops compiling on upgrade: a
  `case "cancelled"` on an order status, the reason `merchant_left`, the error
  code `merchant_departed`, and the selling state `departed`. Such code handled
  something the gateway never sent, so deleting it changes nothing at run time.
- 64ac57f: The SDK reads what only informs leniently, so an older release keeps working
  when Agentify adds to it. A field it does not know on an event, a card, a
  receipt, an envelope or around an order is left out of what the merchant's
  code receives. An event of a kind it does not know is skipped: the rest of the
  poll is handled, and the problem reporter receives one non-fatal
  `event_skipped` problem naming the event's type and its order. A word it does
  not know reads `unknown` in an order's `status` or `payment_status`, an
  event's `reason` and the `result` beside `ok: true`, where the call still
  succeeded. A price question for a `purpose` it does not know is left
  unanswered with one non-fatal `quote_skipped` problem, which counts as a silent
  price check: a synchronous card sells at its card price, and other modes
  refuse the sale. The SDK's
  `OrderStatus`, `PaymentStatus`, `OrderWithStatus`, `OrderList`, `OrderEvent`,
  `OrderCallResult` and `OrderCallResponse` types carry that one extra word.
  
  What an order delivers is read as closed as it is written, off the stream and
  read back: an unknown field or address shape there fails the poll or the read
  rather than reach the merchant's code with part of the order missing.
  
  On a version mismatch the worker takes no new work, lets handlers already
  running send their answers for as long as a poll may take, and then stops,
  reporting any order still in a handler as abandoned.
  
  The contracts package gains `readerOf(schema)`, which makes this reader out of
  any of the merchant's documents, with the `Read`, `UnreadEvent` and
  `UnknownWord` types and `UNKNOWN_WORD`. The schemas themselves stay closed:
  they are what a gateway writes, and a field it was not meant to send is
  refused on its side.
  
  Every SDK call names the package's release in its `user-agent` header as
  `agentify-sdk/<version>`, the version only when the manifest beside the code
  is this package's own. The gateway notes it beside a key's last use whenever
  it writes that down. Nothing is refused on it.
  
  `CONTRACT_VERSION` moves from `2` to `3`, once, at the switch from strict to
  lenient reading: a release up to 0.7.1 reads strictly, and now stops at its
  first poll answer saying it is out of date rather than failing on a later
  addition. From here the version moves when a field or a word is renamed or
  removed, a field's meaning changes, anything is added to what an order
  delivers, or a card mode, selling state or kind of message is added; an
  informational field, an event kind or a status, reason, result or purpose
  word leaves it alone. Every schema's identity moves with it, to
  `urn:agentify:contract:3:<name>`.

### Patch Changes

- 8cd051f: The description of `orders.list` says that an order which ended rejected or
  expired with nothing charged or held is deleted thirty days after it was last
  written, after which `orders.get` refuses it with `no_such_order` and no list
  carries it.
- Updated dependencies [92b905b]
- Updated dependencies [f9a2ce4]
- Updated dependencies [d9bcb7d]
- Updated dependencies [f662789]
- Updated dependencies [3099788]
- Updated dependencies [581ee20]
- Updated dependencies [c43b0e9]
- Updated dependencies [64ac57f]
  - @nuanu-ai/agentify-contracts@0.14.0

## 0.7.1

### Patch Changes

- Updated dependencies [86b7a11]
- Updated dependencies [62c747f]
- Updated dependencies [17bea5f]
- Updated dependencies [68d2f89]
  - @nuanu-ai/agentify-contracts@0.13.0

## 0.7.0

### Minor Changes

- 4430b48: A merchant can now close fulfillment of an order through Agentify, and the
  words for a paid order without delivery no longer speak of refunds. This
  release removes and renames exported names and wire words without aliases, so
  code written against the previous release needs the changes below before it
  compiles or reads the new gateway correctly.
  
  Closing an order is `order.close({ message })` on any bound order in the SDK,
  and `POST /v0/orders/:order_id/close` on the wire. It stops fulfillment
  through Agentify for that order and answers `{ ok: true }`, also on a retry,
  which keeps the first closure's time and optional message except after a late
  payment, described below. The message is the merchant's statement to the
  buyer, read by the buyer's agent as the merchant's own words. It is plain text
  of at most 2000 characters, an emoji counting as one: markup, character
  references, control characters other than the line feed, bidirectional
  control characters and half of a character cut in two are refused with 400.
  Agentify confirms no refund or agreement. Closing is refused, with the order
  left as it is, as `fulfillment_complete` on an order already delivered or
  shipped and as `nothing_to_close` on one that ended without a charge. It
  cancels no payment: a payment Agentify had already asked the facilitator to
  execute may still go through after the closure. If it does, the merchant
  receives `order.unfulfilled` with the new reason `paid_after_closure`, and the
  order is on `orders.list({ open: true })` until the merchant closes it again,
  which records that closure's own time and message.
  
  The words that change, old to new:
  
  - order status `refund_due` is now `unfulfilled`, and `refunded` is now
    `fulfillment_closed`; the receipt outcome words change the same way;
  - the event `order.refund_due` is now `order.unfulfilled`, and
    `ORDER_EVENT_TYPES.REFUND_DUE` is now `ORDER_EVENT_TYPES.UNFULFILLED`;
  - `RefundDueReasonSchema` and the type `RefundDueReason` are now
    `UnfulfilledReasonSchema` and `UnfulfilledReason`, and the JSON Schema
    export `refund_due_reason` is now `unfulfilled_reason`; its words are
    `refused`, `deadline_passed`, `merchant_left` and the new
    `paid_after_closure`;
  - the order call result `debt_closed_by_delivery` is now `delivered_late`;
  - the error code `refund_already_settled` is now `fulfillment_closed`, and
    `fulfillment_complete` and `nothing_to_close` are new.
  
  What is added: `payment_status` (`not_paid`, `paid` or `unresolved`) is a
  required field of `OrderWithStatus` and of the agent's order document, and
  `merchant_closure` an optional one, with `PaymentStatusSchema`,
  `MerchantClosureSchema`, `OrderCloseRequestSchema` and
  `OrderCloseResponseSchema` and their types. `OrderCalls` gains a required
  `close`, so a test double of it must add one. On the agent's order document,
  `payment_status` is an open word like `status`; every `unfulfilled` order
  carries a `reason` saying why nothing was delivered, and a paid
  `fulfillment_closed` order carries the reason `merchant_closed` in Agentify's
  words beside the merchant's.
  
  A worker on the previous SDK cannot read the new gateway: `orders.get` and
  `orders.list` fail on the new required field, a poll carrying
  `order.unfulfilled` fails, and a late delivery's `delivered_late` reads as an
  answer it cannot understand. Move workers to this release together with the
  gateway. `CONTRACT_VERSION` stays `"2"`, as ADR-0006 allows until the first
  merchant we do not control.

### Patch Changes

- 74fd27f: `createClient` has a doc comment for the integrator: what it builds, that
  building it calls nothing, what it throws at once (no key, an address that is
  not http or https), what it leaves to the first call (no address at all, a key
  the gateway refuses), and what the client it returns carries. The doc comment
  on `stop()` no longer opens twice, so an editor shows it from its first word.
  No type or behaviour changes.
- Updated dependencies [b2e54b0]
- Updated dependencies [0ab1aa4]
- Updated dependencies [0266c2a]
- Updated dependencies [d61411b]
- Updated dependencies [4430b48]
- Updated dependencies [82b9c5e]
- Updated dependencies [9e27b45]
- Updated dependencies [0f35b18]
- Updated dependencies [243f500]
  - @nuanu-ai/agentify-contracts@0.12.0

## 0.6.0

### Minor Changes

- ce03246: `CardInput`, the card a merchant writes for `catalog.publish`, is one shape per
  fulfillment mode, so the TypeScript compiler refuses what publishing refuses
  between the mode and the other fields. A card delivered to the agent, `"sync"`
  or `"async"`, must declare `result`, and a parcel's card, `"ship"`, must not; a
  parcel must name `ship_within_seconds` and `price_check: "handler"`, and no
  other card may name `ship_within_seconds`; only an `"async"` card names
  `fulfill_deadline_seconds`; and `"confirm"`, which cannot be published, is not
  offered. A card that compiled before and that publishing refused now fails to
  compile where it is written. A `Card` read back is not split by mode, so it is
  not a `CardInput` as it stands: republish the card your code holds, or assert
  the read-back one's type. Publication itself, the zod schemas and the JSON
  Schema are unchanged.
  
  The descriptions say what is true about refunds and receipts.
  `refund_already_settled` and the `refunded` status mean a refund is recorded
  for the order. A refund a merchant sends from their own wallet is not seen and
  records nothing, and no refund can be recorded yet, so nothing is answered with
  that code today and a late delivery still closes an order owing a refund. A
  receipt is written as the goods of a paid purchase are released, on delivery or
  when a parcel's shipment is recorded; a paid order whose goods have not come,
  one owing a refund, and a charge an operator records by hand have none, so the
  receipt list is not an account of the money that came in. `CONTRACT_VERSION`
  does not move.

### Patch Changes

- Updated dependencies [ce03246]
  - @nuanu-ai/agentify-contracts@0.11.0

## 0.5.2

### Patch Changes

- 8717d7a: The descriptions say where a buyer's money goes now that Agentify takes a
  commission. The payTo of every payment request is the merchant's payout
  contract, a 0xSplits split with no owner, which keeps what it is paid until
  anybody sends a payout and then sends 99.9% to the merchant's wallet and 0.1%
  to Agentify. Each share is rounded down to the smallest unit of USDC, and one
  unit stays behind on the payout contract and on each balance a payout credits,
  so 1.000000 USDC paid into a new payout contract reaches the merchant's wallet
  as 0.998998 at its first payout. Nobody, Agentify included, can change whom the
  contract pays, and Circle, which issues USDC, can freeze USDC at any address,
  the payout contract and the shared 0xSplits warehouse included.
  `payout_wallet` keeps its name and shape and is where the merchant's share
  arrives; it is never the payTo of a payment request, and what it receives is
  one transfer per payout from the 0xSplits warehouse, not a transfer from each
  buyer. A receipt's `transaction` is the buyer's payment into the payout
  contract, and a refund owed is the whole price, paid from the merchant's own
  wallet, while the commission stays with Agentify. The SDK's README says the
  same. No schema, type or behaviour of either package changes, and
  `CONTRACT_VERSION` does not move.
- Updated dependencies [8717d7a]
  - @nuanu-ai/agentify-contracts@0.10.1

## 0.5.1

### Patch Changes

- 6f8dc38: An acceptance given an argument says so. TypeScript refuses an argument to
  `order.accepted()` and `order.accept()`, but JavaScript can pass one, the
  removed `eta_seconds` above all, and it went nowhere without a word. The order
  is still taken on, and the worker's problem channel now reports
  `acceptance_argument_ignored` naming the order.
- a2bbe78: The doc comments an editor shows for the client, the worker, the errors and
  the contract's schemas are rewritten for the engineer integrating a shop: what
  a call does, what it refuses and what it returns. Two published route
  descriptions are corrected: accepting an order no longer says the merchant
  states how long delivery will take, since the acceptance carries no field and
  the card's delivery deadline holds; and the order-status description no longer
  cites an internal document. No schema, type or behaviour changes.
- 6f8dc38: A poll the gateway refuses for good no longer reports that a revoked key has
  to be replaced whatever the refusal was. The worker's problem now says that no
  new orders arrive until what the gateway's own words name is fixed; a revoked
  key is one such case, and a merchant selling through a connected WooCommerce
  shop is another.
- Updated dependencies [a2bbe78]
- Updated dependencies [6f8dc38]
  - @nuanu-ai/agentify-contracts@0.10.0

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
