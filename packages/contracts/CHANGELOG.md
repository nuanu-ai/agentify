# Contracts release history

## 0.9.0

### Minor Changes

- 4f9bab1: An acceptance carries nothing. `eta_seconds` is gone from `AcceptanceSchema`,
  from `order.accepted()` and `accept()` in the SDK, and from the `Acceptance`
  type the SDK re-exported, because nothing kept the number and no agent saw it.
  A body that still names it is refused with words saying it was removed and to
  answer `accepted()` with nothing in it. A worker on an earlier SDK that sent it
  has to move to this one.
- 4f9bab1: The agent's order status carries `reason`, a code and a sentence, where
  Agentify and not the merchant ended the order and the status word alone would
  blur the next step: `rejected` with `unavailable`, `price_check_unanswered` or
  `payment_not_settled`, and `expired` with `price_expired` or
  `merchant_timed_out`. The codes are an open word whose known values are
  `ORDER_ENDING_REASONS` (`OrderEndingReasonSchema`). A reason never stands
  beside a merchant's `refusal`. The field is optional and the storefront's
  documents are read open (ADR-0006 §5), so `CONTRACT_VERSION` does not move.
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

### Patch Changes

- 4f9bab1: A card that leaves out `merchant_item_id`, `title`, `description` or `price`,
  or names a `fulfillment` mode or a declared field's `type` that does not exist,
  is refused in a sentence saying what the field is or which words it takes,
  rather than in the validation library's "Invalid input: expected string,
  received undefined" or "Invalid option".
- b5a4c4f: The description of `delivery_does_not_match_card` says what the gateway now
  holds a delivery to: the result the order was sold with, which its card
  declared when the order was made and which a card republished since does not
  change.
- 4f9bab1: The description of `ShipToSchema`, which a listing's purchase schema carries,
  says that the price on a parcel's card is the goods alone and that a purchase
  is priced for the address it names, with shipping to it included.
- 4f9bab1: zod is required at exactly the version the gateway runs, 4.4.3, rather than by
  a range. A merchant's install could take a newer zod that counts a string's
  length differently, and then the SDK's offline card check passed a card that
  publication refused (an emoji in a description of 500 counted once, not twice).
  The two are one check again.

## 0.8.0

### Minor Changes

- 436e368: The calls that only a merchant's dashboard ever made leave the contract, because the dashboard now calls the gateway inside the process the two share and holds no key: the registration route (`POST /v0/merchants`) with `RegistrationRequestSchema` and `RegisteredMerchantSchema`, the two routes at `/v0/keys/dashboard` with `DashboardKeySchema` and `ForgottenDashboardKeySchema`, and the payout-wallet write (`POST /v0/payout-wallet`) with `PayoutWalletRequestSchema`. Reading the wallet with `GET /v0/payout-wallet` stays. Their codes leave `ERROR_CODES`: `not_invited`, `not_a_dashboard_key`, `key_made_for_a_dashboard`, `wallet_change_nobody_to_tell`, `wallet_change_not_announced` and `wallet_change_raced`. So does `wallet_change_unconfirmed`, which nothing could send once the gateway told the dashboard of a change by a call inside the process rather than over a route. `DELETE` leaves `HTTP_METHODS`, since no route uses it any more. Code that matched any of these by name no longer compiles against this version. Every key is now one the merchant issued, so the `this_call` of a key list is always one of its keys. No SDK worker calls these routes or reads these codes, so `CONTRACT_VERSION` does not move.
- f17084b: A card can describe a parcel (ADR-0033): `fulfillment: "ship"`, with
  `ship_within_seconds`, the time to hand the parcel to a carrier counted from the
  charge, at most thirty days, and a price check answered by the merchant's own
  handler, whose answer is the whole price with shipping. Such a card declares no
  `result`, so `result` is optional in the schema and still required, by rule, on
  every other mode; in TypeScript, `Card["result"]` is optional.
  
  Where a parcel goes is a block of its own (ADR-0032): `ShipToSchema`, in the
  Agentic Commerce Protocol's names, `ShipToLocalitySchema`, the place without the
  person, `ErasedShipToSchema` and `localityOf(address)`. A purchase request takes
  `ship_to`; a price question carries its locality; and an order reads the
  locality before it is paid, the whole address once it is, and only
  `{ erased_at }` once Agentify has let go of it: the merchant took the order on,
  or the order ended or came to owe a refund without them. Two error codes join a purchase's
  refusals: `ship_to_does_not_fit`, for an address on a product that is not
  shipped or none on one that is, and `ship_to_changed`, for a payment carrying an
  address other than the one the purchase was priced for.
  
  The contract version stays `"2"`: it moves only once a merchant we do not
  control runs a published SDK (ADR-0006 §2).
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

- d483a58: The description of the agent's order status route no longer says the order's
  identifier is handed to exactly one party: the merchant and Agentify hold it
  too, as parties to the sale, and it appears in no catalog or listing
  (ADR-0011).

## 0.7.0

### Minor Changes

- 6f8521e: The calls and documents about the key a dashboard holds are called by the
  product's name for it. The two routes move from `/v0/keys/cabinet` to
  `/v0/keys/dashboard`, `API_ROUTES.issue_cabinet_key` and
  `API_ROUTES.forget_cabinet_key` become `issue_dashboard_key` and
  `forget_dashboard_key`, `CabinetKeySchema` and `ForgottenCabinetKeySchema` become
  `DashboardKeySchema` and `ForgottenDashboardKeySchema` (documents
  `dashboard_key` and `forgotten_dashboard_key`), the types `CabinetKey` and
  `ForgottenCabinetKey` become `DashboardKey` and `ForgottenDashboardKey`, and the
  refusal codes `not_a_cabinet_key` and `key_made_for_a_cabinet` become
  `not_a_dashboard_key` and `key_made_for_a_dashboard`. The old names are gone
  rather than kept beside the new ones. These routes are not on the public origin
  and only the dashboard calls them, so a merchant's own code is affected only if
  it imports one of these names or matches one of the two refusal codes.
- effa6e3: The documents an agent reads take what is added to them later (ADR-0006 §5).
  The catalog page, the card in it and an order's status accept fields this
  version does not name, both beside their fields and inside their parts — the
  seller, a price, a declared field, a merchant's refusal — and a card's
  `fulfillment` and an order's `status` are words whose known values are listed
  beside them, so a word added later is read rather than refused. Such a word is
  an `OpenWordSchema`: lower-case letters, digits and underscores, starting with
  a letter and at most sixty-four characters long. A declared field's `type`
  stays a closed list. The exported `public_card` is now one object rather than a
  branch per mode, so the rule that only some modes name a deadline is stated in
  its description rather than in its structure. The catalog page holds its items
  as they arrive, and the new `cardsOf(page)` reads each one on its own, passing
  over an item that does not read as a card and a card of a mode this version
  does not name, so the rest of the page stays for sale. In TypeScript,
  `CatalogPage["items"]` is `unknown[]`, a card's `fulfillment` and an order
  status's `status` are strings, and `publicCardOf` returns a `ProjectedCard`:
  the card's own fields without the open schema's index signature, and a mode
  this version names. The merchant's own documents stay closed.
- 3862afa: An agent reads who sells. Every card in the catalog and the status of every
  order carry `seller`, the name the merchant sells under and the https origin of
  their shop's own site, each `null` where none was given and neither checked by
  Agentify (ADR-0034). The seller-name document carries `seller_site` beside
  `seller_name`, and a request to the seller-name route may send the name, the
  site or both; a request that sends the name alone is taken as before, and its
  answer gains `seller_site`. A reader validating the card, the order status or
  the seller-name document with an earlier version of this package refuses the
  new fields: update it before reading a gateway that sends them.
  `SellerSchema` and `SellerSiteSchema` are exported. A seller name sent to the
  route is now held to the plain-text rule the card's words are: HTML markup and
  character references such as `&amp;` are refused.

### Patch Changes

- 685b465: The answer route, the `accept` call and the `not_applicable_in_mode` code now
  say that a synchronous order still waiting for its goods cannot be taken on. An
  acceptance from a synchronous handler, or the `accept` call on such an order, is
  refused with `not_applicable_in_mode`, because the goods of that mode travel
  only in the handler's answer and the `deliver` call that would carry them later
  does not exist there.

## 0.6.0

### Minor Changes

- dcf7ec1: `CardSchema` now refuses a card whose title, description or declared field
  title is not plain text: one carrying HTML markup (a tag, or the opening of a
  comment), an HTML character reference such as `&amp;` or `&#8217;`, or a
  control character. A description may still carry line feeds, and an
  ampersand, a comparison or an arrow written as text still passes. Each finding
  names what was found and the character it begins at; nothing is cleaned or
  rewritten on the way in. The rule is the publish door's alone: a card already
  stored is read back exactly as it was, and neither `MerchantCardSchema` nor
  `PublicCardSchema` holds a card to it. `notPlainTextIn` is the rule itself,
  exported for a connector that turns a shop's HTML into text before it
  publishes.
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
- 350d222: `priceProblemsOf`, `PAYABLE_CURRENCIES` and `PAYABLE_DECIMALS` are the rule a
  price a merchant sets is held to: an amount above zero, written in dollars with
  at least two and at most six digits after the dot (the places of USDC, which a
  buyer pays in), in USD or USDC. The gateway applies it to a card's price
  at publication and to a price check's answer, and refuses a price that breaks
  it with a finding on `price.amount` or `price.currency` naming what it found.
  A price of zero is refused by design: a free item is offered from the
  merchant's own site, without a payment. The JSON Schema export states the
  rule on the card's `price` and on a price answer's `price`, and the
  `answer_quote` route says how an answer that breaks it is refused. No schema's
  shape changed, so cards, orders and receipts already written are read back as
  they were.

## 0.5.0

### Minor Changes

- b2de0fe: `IssueKeyRequestSchema` now refuses a label longer than 100 characters, or one
  carrying a line break, a tab or another control character. On the live
  deployment the message that tells a merchant of a new key names it, and the
  key that issued it, by label, so a label is one line a list and a message can
  show whole. Keys already issued are read back
  under whatever they were named; `MerchantKeySchema` is unchanged.
- 4a4f100: The payout wallet is set only through the merchant's cabinet, whose calls to
  the gateway come from inside the stack, when a person sets it on the Settings
  screen. `POST /v0/payout-wallet` is not routed by the public origin at all,
  so from outside it answers as a path the site does not have, and at the
  gateway a key made for the merchant's own code is refused with 403 under
  `not_a_cabinet_key`, for the first address as for a replacement, with nothing
  written or announced. `GET /v0/payout-wallet` still answers any key of the
  merchant's. The descriptions of both routes say who may call them, and the
  publish route's description sends a merchant with no wallet to the cabinet's
  Settings.
  
  No schema changes and `ERROR_CODES` does not grow, since the code is the one
  the cabinet's key routes already refuse under. What changes is what a reader
  of the contract relies on: code written against the previous description
  could set the wallet with its own key, and now it cannot, which is why this is
  a minor release rather than a patch. No SDK worker calls the route, so the
  contract version stays where it is.
- 97529a5: The payout wallet answer now carries `pending`, a required field that is null
  when nothing is waiting and otherwise names the replacement address and
  `takes_effect_at`, the moment it replaces the address paid now. On the live
  deployment a replacement for a wallet already set is announced to every
  cabinet account of the merchant and takes effect forty-eight hours later, and
  a caller that reads its old address back beside a pending change has not
  failed to write. The nested document is published as `pending_payout_wallet`.
  
  Four refusal codes join `ERROR_CODES`, all returned by `POST
  /v0/payout-wallet` alone: `wallet_change_nobody_to_tell`,
  `wallet_change_not_announced`, `wallet_change_unconfirmed` and
  `wallet_change_raced`. No SDK worker reads that route, so the contract
  version stays where it is; a reader holding the previous `PayoutWalletSchema`
  refuses an answer carrying `pending`, which is why this is a minor release.

### Patch Changes

- ae15921: The descriptions of `register_merchant`, `issue_cabinet_key` and
  `forget_cabinet_key` say what is true of them: none is on the public origin.
  Only the cabinet makes these calls, from inside the stack, and from outside
  their paths answer as ones the site does not have. No schema, route or status
  changes, and no merchant's own code ever made these calls.

## 0.4.0

### Minor Changes

- 8394f96: The order document an agent reads now carries `status_url`, a required field
  holding the absolute address of the order's status route. An agent that buys a
  product whose goods come later receives an order and no goods, and until now no
  answer said where to come back for them. Every answer that carries the document
  names the address, the purchase's own answer included. A reader holding the
  previous schema refuses a document with the new field, and the new schema
  refuses one without it, which is why this is a minor release rather than a
  patch.

### Patch Changes

- 8550654: The status route's description stops calling the delivery deadline the end of
  an order whose goods come later. When the deadline passes with no goods, the
  order becomes `refund_due`. That is not an ending: goods the merchant delivers
  afterwards still appear at `status_url` and settle the debt. `refund_due`
  cannot say whether the money has already gone back. The comment on
  `refund_due` in the status vocabulary says the same. The schemas do not change.

## 0.3.2

### Patch Changes

- 35941c2: Identify generated JSON Schema documents with `urn:agentify:contract:2:*`.
  Their validation vocabulary and the runtime contract handshake stay unchanged;
  code that indexed the generated documents by the previous `$id` must use the
  Agentify identifier.
- d1f6870: Publish the merchant SDK, contracts package and `agentify` command under their Agentify names. The wire contract and runtime behavior are unchanged.
- c7c26b8: Say whose ceiling a description is held to, and how long the text actually is.
  The refusal a card gets for a description over five hundred characters used to
  read "a description is at most 500 characters, which is what a listing carries",
  and a merchant reading that could not tell whether the limit was ours, the
  payment protocol's, or something about the alphabet they write in. It is the
  discovery catalog's, documented rather than enforced by anything of theirs we
  can run, and the sentence now says so — along with the length of the text that
  was refused, which is the one number the merchant cannot see for themselves and
  the one they have to act on.

  Nothing about the shape moves: the ceiling is the same five hundred characters,
  the JSON Schema still carries `maxLength: 500`, and `CONTRACT_VERSION` does not
  change. What changes is what a merchant reads when the door turns their card
  away.

These entries record releases published under the former package names.
Version numbers and release facts are retained; former package and command
identities are described generically. The original wording remains in Git history.

## 0.3.1

### Patch Changes

- 99c959c: The purchase route's description says that the address answers on GET as well as on POST, that an unpaid call with no document gets the challenge and a GET is never read for payment, and that the challenge describes the purchase.

## 0.3.0

### Minor Changes

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

### Patch Changes

- 3d815e9: License both public packages under Apache-2.0 and include the Nuanu AI
  attribution notice in their npm archives.

## 0.2.1

### Patch Changes

- The package pages on npm say what the packages are. Nothing in the code
  changes: the README of each package is rewritten for somebody meeting the product
  on the registry — what the merchant SDK sells and the two addresses it can be
  pointed at, and why the contracts package exists and who installs it directly —
  and both manifests gain a description written for the same reader, keywords,
  and a link to the documentation.

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

## 0.1.0

### Minor Changes

- Publish the first installable merchant SDK and its contract schemas.
