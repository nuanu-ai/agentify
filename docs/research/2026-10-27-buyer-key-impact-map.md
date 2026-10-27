# Buyer-created purchase key: proposal and consequence map

Date: 2026-10-27. Status: deferred proposal, retained for a later product
and contract decision.

The product owner chooses a smaller recovery fix: the existing quickstart
buyer saves the original invoice before sending payment and can resume that
purchase. Its documentation and tests follow that behavior. Recovery by a fresh
payment signature from the same wallet remains the rule in
[ADR-0011][adr11]. The selected work changes no server authentication and adds
no buyer npm package. This note records the alternative considered; it does not
approve its implementation or change an ADR.

The source evidence is pinned to
[`ae941b1dcbabe5313e5ab7d3a1a4922d440340d3`][source]. In the consequence map,
"Code" identifies behavior established by those sources, "Decision" identifies
a recorded rule, and "Inference" identifies a consequence the proposed design
would have to handle. "Unknown" marks a question the inspection does not
answer. The rows identify responsibilities and behaviors. They are not a
count of files to change, and no failure frequency or implementation effort
was measured.

## The deferred proposal

Before its first request to create a purchase, a buyer generates and retains a
private order key. A header carrying that key is mandatory on order creation
and on payment. Reusing the key means resuming the same purchase. A buyer no
longer signs a payment solely to recover or read a purchase that is already
paid.

The order key is a bearer secret for one purchase. It is separate from the
wallet's private signing key and establishes no buyer account. The proposal
names no header, accepted format or retention period. It also leaves open how a
buyer learns the status address when the first purchase response is lost.
Those details belong to a future decision if this proposal is resumed.

A client-generated secret would let a buyer retain a way back before Agentify
answers. That transfers part of the ownership boundary to the client: it must
create an unpredictable secret, save it before the request and keep it across
retries. The gateway must bind the secret atomically to one intended purchase,
including concurrent requests and changes to the requested product or inputs.
The present server-generated secret already protects order reads, so choosing
its origin changes more than the place where a random string is generated.

Retention and the transition for existing orders are the other costs. Agentify
forgets some unpaid attempts after thirty days. A random key contains no
history that distinguishes a new purchase from a forgotten one. Existing
orders already have server-generated buyer keys, but a buyer that lost its
response may not know that key. Removing the wallet-signature recovery route
would remove its remaining proof of ownership. These costs require explicit
rules even if the code that sends the header is small.

## Purchase and order routes

| Place | Present behavior | Consequence of the deferred proposal | Basis |
| --- | --- | --- | --- |
| 1. [Opening a purchase, `gateway.ts:1726`][begin] | Each admitted `beginPurchase(itemId, params, shipTo)` call creates a new order and generates its `buyerKey` on the server at line 1812. | Accept the buyer's key and resolve a repeated intent before creating another order, asking another price or emitting another set of effects. | Code; consequence is an inference. |
| 2. [`GET /x402/:item_id/purchase`, `routes.ts:493`][get-probe] | GET always calls `probeAnswer`. A payment on GET is not read for payment. The challenge names no order, and no order is created. | Preserve a probe that needs no purchase key. Requiring the header on this GET would prevent existing discovery callers from obtaining their challenge. | Code. |
| 3. [Unpaid empty POST, `routes.ts:519`][post-probe] | POST without a body or with `{}` is a probe. A body containing `params`, including empty params, is a purchase. | Apply the requirement to actual creation and payment without turning the validator's empty POST into an authenticated purchase. | Code; placement of the check is an inference. |
| 4. [Payment naming a held order, `routes.ts:524`][known-payment] | The route selects the order from `accepted.extra.order_id` and calls `payPurchase`. It checks no buyer-key header. | Require the presented order secret to match that order before accepting payment. A public order identifier would cease to be enough to pay first for another buyer's unpaid order. | Code; changed ownership rule is an inference. |
| 5. [Unknown or unreadable payment, `routes.ts:578`][new-after-payment] | With a valid purchase body, a payment naming no held order, or an unreadable payment, falls through to a new purchase and a fresh challenge. | Define a refusal for a stale payment or forgotten intent that cannot silently open another purchase under a key the buyer believes is a retry. | Code; response policy is unresolved. |
| 6. [`GET /x402` and `/x402/catalog`, `server.ts:111` and `gateway.ts:865`][catalog-root] | The root redirects to the catalogue. The catalogue reads and projects cards; it creates no orders or buyer keys. | Catalogue discovery needs no purchase secret. Its `purchase_url` must still describe a usable purchase contract. | Code; catalogue projection is at [gateway.ts:865][catalog]. |
| 7. [`GET /x402/orders/:buyer_key/status`, `routes.ts:328`][status-route] | The bearer key alone finds the order. Every response has `Cache-Control: no-store`; an order identifier and an unknown key receive the same refusal. | The read can retain this protection. Decide how the buyer obtains the whole address before its first answer: a documented construction rule, a repeated POST that resolves by key, or another specified path. | Code; recovery-address rule is unknown. |
| 8. [`GET /v0/orders/:order_id` and `/v0/orders`, `api.ts:718`][merchant-reads] | Merchant reads require the merchant key and scope records to that merchant. `open=true` narrows the list to work still owed; ordinary unpaid attempts are excluded from that narrowing. | Keep the merchant routes on ordinary order identifiers. They do not need or reveal the buyer secret. Deleting lapsed attempts continues to affect these reads. | Code and public contract. |
| 9. [Worker and order mutations, `api.ts:750`][merchant-mutations] | Poll, answer, accept, deliver, refuse and close use merchant authentication. Delivery repeats are recognised by the order's ordinary identifier. | Keep the secret out of worker envelopes and merchant events. The same intent must retain its order identifier so merchant idempotency continues to apply. | Public contract; inference about preserving identifiers. |
| 10. [Dashboard Orders, `orders.tsx:22`][dashboard-orders], and [admin routes, `routes.ts:49`][admin-routes] | Signed-in merchants and operators read orders through their own sessions. The [operator projection][operator-read] deliberately withholds the status URL, goods and buyer secret. | These pages remain independent of buyer authentication. They do not provide a buyer with a lost secret. | Code. |

## Concurrency, payment and retention

| Place | Present behavior | Consequence of the deferred proposal | Basis |
| --- | --- | --- | --- |
| 11. [Buyer-key uniqueness, `schema.ts:263`][unique-key], and [duplicate handling, `store.ts:1017`][duplicate-key] | PostgreSQL has a global unique index on `record.buyerKey`. A duplicate throws an error; the memory store also rejects it. Neither operation returns the first order as a successful replay. | Add an atomic way to create once or observe the same order. A replay can arrive while the first price question is still pending, with `created` and no price. [The current state projection][where-stands] would call that `under_way`, although no payment has been offered. The replay needs a defined way to join or observe the first price question without asking a second one. | Code; concurrent replay semantics require implementation and a decision on the response. |
| 12. [Product and params comparison, `gateway.ts:2094`][compare-params] | A verified payment is refused if the request names another product or different canonical params. An unpaid request instead creates another order. | Define a conflict for the same key with changed product or params, before any new creation or charge. Decide which normalised input forms count as the same intent and how the first card snapshot governs a replay after republication. | Code; intent equivalence is unresolved. |
| 13. [Address comparison, `gateway.ts:2085`][compare-address], and [address erasure, `runner.ts:1765`][erase-address] | `ship_to` is compared while it remains stored. Once erased, the record retains only `erasedAt`. A payment may omit the address and pay for the one originally priced. | Intent comparison must respect address erasure. Retaining the full address indefinitely for a retry fingerprint would change that boundary. The current code does not promise to detect changed addresses after erasure. | Code; future representation and comparison rule are unresolved. |
| 14. [Expired unpaid orders, `gateway.ts:1880`][ended-payment] | An ended order with nothing held takes no payment. A late payment applies quote expiry before verification. | A repeated key must not silently refresh a terminal attempt into a new purchase. Decide whether it returns the ended order or a refusal and how a buyer explicitly starts a new purchase. | Code; response policy is unresolved. |
| 15. [Unpaid-attempt deletion, ADR-0048][adr48], and [the deletion query, `store.ts:1245`][delete-lapsed] | The daily job deletes rejected or expired attempts thirty days after their last write only if they have no verified payment, held goods, presented payment, receipt or payment claim. Paid orders and orders carrying money or goods are retained. | State the lifetime of the same-key guarantee. After deletion, the key alone cannot distinguish a retry from a new intent. A tombstone, a bounded guarantee or another retention rule is a product and storage decision. | Decision and code; indefinite idempotency is not established. |
| 16. [Unresolved payment, ADR-0027][adr27], and [`gateway.ts:3236`][unresolved-refusal] | Agentify takes no second payment while the original outcome is unresolved. Background recovery uses chain evidence and does not submit settlement again. | A retained key can expose the unknown outcome to the buyer, but cannot establish nonpayment or justify another purchase. Payment-outcome recovery remains Agentify's responsibility. | Decision and code. |
| 17. [Fifty waiting purchases, ADR-0043][adr43], and [admission, `store.ts:968`][admission] | Creation locks the merchant row, checks the selling integration and counts waiting purchases before inserting. Fifty is the limit. | Resolve existing keys before applying new-purchase admission. A full limit must not block a buyer from recovering its own purchase. Fresh keys remain cheap, so this proposal alone does not solve unpaid load or denial of sales. | Decision and code; replay ordering is an inference. |
| 18. [Sale checks, `gateway.ts:1758`][sale-checks], and [first-payment checks, `gateway.ts:1956`][payment-admission] | New creation checks the card and seller. First payment rechecks unserved orders and worker silence. Payments that release goods already made have specific exceptions. | Find the existing order before treating a retry as a new sale against today's card. Preserve the separate rules for its first real payment and held goods. A pause or card change must not hide a purchase already accepted. | Code; ordering consequence is an inference. |
| 19. [Synchronous waiting, `gateway.ts:2147`][sync-park] | The park is keyed by order and verified payer; concurrent calls by that payer both wake. The ownership and state change occur under the order lock. | Define responses for parallel calls during price calculation, verification and settlement. A repeated key must not cause a second handler run or settlement. Existing execution locks can remain, but they do not provide creation idempotency by themselves. | Code; repeated-key behavior is unresolved. |
| 20. [Returning paid purchase, `gateway.ts:1990`][returning-flow], and [`returning-payment.ts:44`][returning-payment] | A fresh signature proves control of the payer's wallet. The gateway checks its terms, signature, expiry and nonce claims without requiring enough balance to pay again. It never charges that returning payment. | This is the read-proof mechanism the proposal removes. Initial payment verification and the one-use authorization guard still govern real charges. | Code. |
| 21. [Held synchronous goods, `runner.ts:1605`][held-goods] | `delivered_unpaid` and late-held-goods instructions ask for a real new payment on the same order. The goods have not been released. | Keep this distinct from reading an already paid order. A retained purchase secret does not pay for held goods; a valid authorization and the existing ownership constraints remain necessary. | Code. |
| 22. [Refusal advice, `routes.ts:698`][wrong-payer], and [`gateway.ts:2033`][verify-advice] | `not_this_purchase` and verification refusals advise a fresh payment from the original wallet to recover a purchase already paid. | Replace the read-recovery advice if the proposal is adopted, while preserving instructions for a real payment that failed verification. Define precedence when a correct secret accompanies a stale or unrelated payment. | Code; new refusal wording and precedence are unresolved. |
| 23. [Failure after payment arrived, `server.ts:292`][partway-failure] | A general `gateway_failed` response tells the buyer to sign the same request again from the same wallet and marks the call non-retryable. | Update this separate failure path to direct the buyer to its retained intent and unknown result. Changing only ordinary payment refusals would leave contradictory instructions. | Code. |
| 24. [Payee selection, `gateway.ts:1823`][payee-snapshot], and [challenge construction, `routes.ts:741`][challenge-payee] | `StoredOrder.payTo` stays null until verification. An order's payment challenge reads the merchant's current payee, while its price and purchase snapshot belong to the order. | Define stale-payee handling. Resuming the same unpaid order does not by itself imply a byte-identical challenge across a payout-wallet change. Reusing the order must preserve its price without claiming that a changed payment destination is the original invoice. | Code; replay behavior across wallet changes is unresolved. |

## Buyers, documentation and contract ownership

| Place | Present behavior | Consequence of the deferred proposal | Basis |
| --- | --- | --- | --- |
| 25. [Quickstart buyer, `buyer.mts:52`][example-buyer] | It sends an unpaid POST without an order secret, signs once and saves the status URL only after an order response arrives. A lost answer leaves it no address to retain. | It would need to generate and save a secret before creation, carry it on both requests and recover without relying on a received order response. The selected smaller fix instead retains the original invoice and uses the existing signature recovery contract. | Code; selected scope is the product owner's instruction. |
| 26. [Dashboard link to the quickstart, `cards.tsx:77`][dashboard-quickstart] | The dashboard leads engineers to the quickstart. The WooCommerce test-purchase text warns about a paid shop order; it is not a separate payment signer. | The portal's automatic buyer to update is the included program. No separate dashboard signing caller was found in the inspected application sources. | Code and repository search. |
| 27. [Shared slice buyer, `buyer.ts:138`][slice-buyer] | `wrapFetchWithPayment` handles the exchange; `buy` sends no purchase secret. `challenge` is an unpaid GET and `status` reads a supplied whole URL. | Its purchases would fail a mandatory-header rule until changed. It is used by [`pnpm buy`][buy-command], [`pnpm smoke`][smoke-command], [`pnpm smoke:split`][split-command] and slice tests. Probe and status reads can keep their existing contracts. | Code. |
| 28. [Bootstrap buyer, `bootstrap-command.ts:1193`][bootstrap-buyer] | The bootstrap command has its own payment wrapper and purchase request, independent of `makeBuyer`. Its preliminary challenge read at line 1156 is GET. | Update its purchase separately if the proposal proceeds. Preserve unpaid challenge inspection and spending controls. | Code. |
| 29. [Stand buyer, `stand-buyer.ts:189`][stand-buyer] | `startPurchase`, `payFor` and `payBadly` are separate POST operations with no order-secret header. Manual and combined flows use them. | Retain one key across start and pay actions. An intentionally bad payment should still pass the purchase-key check when testing the payment refusal itself. | Code; fixture consequence is an inference. |
| 30. Acceptance agents under `.claude/agents` | The directory is absent from both the inspected worktree and the main local checkout. No acceptance-agent files there were available to inspect. | Obtain the actual source before claiming those buyers were updated or remain compatible. No conclusion about external agent instructions follows from their absence here. | Unknown outside the inspected checkouts. |
| 31. [Purchase body and descriptions, `api.ts:241`][purchase-contract] | The strict body contains `params` and optional `ship_to`. Purchase, auth and status descriptions explain the server key and signature recovery. | Document the header without putting the secret into params or the body. Choose its name, validation limits and errors for absence, invalid input and mismatch. Update exported route and schema descriptions that explain ownership. | Public contract; header details are unresolved. |
| 32. [Order repeats, `orders.md:665`][repeat-docs], [failure table][failure-docs] and [quickstart recovery][quickstart-docs] | The docs teach the buyer to keep payment requirements, sign again with the same wallet and avoid a new purchase. The quickstart says a fresh run makes another purchase. | A mandatory-key design would change both the buyer recipe and the seller's explanation. Merchant delivery idempotency and actual repayment for held goods retain their own rules. The chosen fix updates the existing recipe without adopting the new authentication proposal. | Documentation and selected scope. |
| 33. [`llms.txt`, `llms.ts:79`][llms] | The agent recipe requires retaining payment requirements and the signed payment, then signing again to recover a lost answer. | Update the recipe if ownership changes. Its current [parcel-example test][llms-test] checks the JSON body against the purchase schema; it does not establish that a header is retained across the exchange. | Code and generated public text. |
| 34. [Portal example ownership, `portal-fixtures.test.ts:1`][portal-fixtures], and [buyer runtime checks][buyer-tests] | JSON examples are shared files for cards and quote requests/responses. The quickstart includes `programs/buyer.mts`; the SDK fence test compiles that same program and the slice test runs it. | Preserve the shared source when changing the example. A JSON-body schema fixture alone cannot verify a mandatory header or restart recovery. | Code; compilation owner is [portal-fences.test.ts:17][portal-fences]. |
| 35. [Failure-table ownership, `portal-tables.test.ts:436`][portal-tables] | State-machine scenarios cover the failure table, including a lost buyer answer. The table's admission-refusal rows are checked by gateway HTTP tests. | Update the affected behavior checks and HTTP scenarios. A different read credential does not alone justify changing the money state machine. | Code; affected-test scope is an inference. |
| 36. [Bazaar declaration, ADR-0012][adr12], and [`x402.ts:288`][discovery-builder] | Discovery describes a JSON POST with an input example/schema. Unpaid GET and empty POST supply its challenge. The declaration contains no private header for a purchase. | Keep concrete secrets out of discovery metadata. A future recipe may describe a required header, but acceptance by a real external listing or buyer remains unproven by Agentify's local schema checks. | Decision and code; live compatibility is unknown. |

## Secret boundaries and existing orders

| Place | Present behavior | Consequence of the deferred proposal | Basis |
| --- | --- | --- | --- |
| 37. [Secret boundary, ADR-0011][adr11], [requirements, `x402.ts:174`][requirements], and [facilitator call][facilitator] | Requirements carry the public `order_id`; the facilitator receives the payment payload and requirements. The buyer secret reaches neither. Bazaar can publish requirements and their `extra`. | A buyer-key header must stay on the buyer-to-gateway request. Do not copy its value into challenge data, `accepted.extra`, discovery examples, an authorization or a facilitator call. | Decision and code. |
| 38. [Merchant order projection][merchant-projection], [order analytics][analytics], and [Caddy filtering][caddy] | Merchant documents and analytics use ordinary identifiers without the buyer secret. Caddy already deletes request URI and request/response headers from runtime logs; telemetry uses route patterns. The [buyer-key boundary test][boundary-test] covers merchant, payment and analytics views. | Preserve those exclusions in new validation and error paths. There is no evidence that the current Caddy configuration leaks the proposed header. PostgreSQL duplicate handling also deliberately withholds driver causes that can contain full records. | Code; new-path requirements follow the existing boundary. |
| 39. [WooCommerce order handling, `woo-worker.ts:188`][woo-known], and [its claim at line 309][woo-claim] | The connector recognises a sale by Agentify's ordinary order ID, its claim and the saved shop outcome. A WooCommerce `orderKey` belongs to shop download permission and differs from Agentify's buyer key. | Keep the same core order ID for a resumed intent so the connector sees the same sale. Merchant execution needs no new buyer credential. Do not mix the two order secrets. | Code. |
| 40. [Buyer-key backfill, `0028_order_buyer_key.sql:7`][legacy-key], and [the stored-record contract][stored-key] | Every current `StoredOrder` has a server-generated `buyerKey`. The migration gives old rows random keys and explicitly records that nobody holds those keys, because buyers received an identifier-based status address. A buyer can also lose a newer response carrying its key. | Decide the transition before removing fresh-signature recovery. Known status URLs can remain valid, but old unknown-key orders and newer lost-answer orders otherwise lose their recovery proof. The existence and count of those rows in deployed production were not checked. | Code and migration commentary; deployed inventory is unknown. |
| 41. [Merchant version rules, ADR-0006][adr6], [shared version][contract-version], and [SDK equality check][sdk-version] | Contract version 5 governs the merchant worker contract. A mismatched poll receives no work and establishes no compatible contact. The storefront has no version handshake. | A buyer-header-only change does not itself prove that the merchant version must move. If an implementation also bumps the shared version, otherwise unchanged workers can stop and cards can leave the catalogue. Review version and release consequences against the merchant shapes actually changed. | Decision and code; a version bump is conditional. |
| 42. [HTTP buying helper][http-harness], [direct `beginPurchase` checks][direct-begin], and [server randomness][randomness] | HTTP helpers send both legs without a purchase key, while application/store tests can create purchases directly. The server currently supplies the unpredictable UUID-based secret. | Update both HTTP coverage and internal creation semantics if the proposal proceeds. Client-generated keys also move unpredictability and safe persistence to the buyer. Server format checks cannot establish that an arbitrary client's secret was chosen randomly. | Code; required coverage and trust consequences are inferences. |

The affected behavior checks include [payment-order tests][payment-tests],
[paid-purchase-return tests][return-tests], [buyer-key boundary tests][boundary-test],
[order-status tests][status-tests], [purchase-door tests][door-tests] and the
[store contract checks][store-tests]. The existing buyer, stand and bootstrap
checks also exercise requests made without the proposed header. These are
coverage owners to revisit if the design is adopted; they were not run for this
research.

## Decisions required before resuming the proposal

The product owner would need to choose the header contract and the ownership
rule for creation and payment, including whether a correct secret is enough to
read a paid order when an attached payment is stale. The gateway needs an
explicit response for every stage a repeated request can observe, including an
order whose price question has not answered yet. A buyer must be told how to
get back to that order before any status URL arrives.

Intent equivalence needs a rule for product, parameters and a parcel's address,
with the erasure boundary preserved. The same decision must explain an expired
unpaid intent and a payee that changes before verification. The thirty-day
cleanup requires a stated lifetime for the replay guarantee. Existing buyers
that never received their secret need a transition if wallet-signature
recovery is retired.

The storefront instructions and discovery declaration need to make the
requirement discoverable to an engineer or an agent. Inspection of external
wallet/client header support reached local transport behavior only. It did not
establish full acceptance of a live purchase, restart recovery, supported
wallet signing, or Bazaar discovery by those clients. A named compatibility
claim would need evidence for that client's complete purchase path.

The source review establishes neither how often buyers lose responses nor how
many deployed orders lack a client-known key. No repository test suite, live
purchase or production database inspection was performed for this note.

[source]: https://github.com/nuanu-ai/agentify/tree/ae941b1dcbabe5313e5ab7d3a1a4922d440340d3
[adr11]: https://github.com/nuanu-ai/agentify/blob/ae941b1dcbabe5313e5ab7d3a1a4922d440340d3/docs/decisions/0011-agent-collection-door.md#L23-L40
[begin]: https://github.com/nuanu-ai/agentify/blob/ae941b1dcbabe5313e5ab7d3a1a4922d440340d3/apps/gateway/src/app/gateway.ts#L1726-L1857
[get-probe]: https://github.com/nuanu-ai/agentify/blob/ae941b1dcbabe5313e5ab7d3a1a4922d440340d3/apps/gateway/src/http/routes.ts#L419-L503
[post-probe]: https://github.com/nuanu-ai/agentify/blob/ae941b1dcbabe5313e5ab7d3a1a4922d440340d3/apps/gateway/src/http/routes.ts#L493-L524
[known-payment]: https://github.com/nuanu-ai/agentify/blob/ae941b1dcbabe5313e5ab7d3a1a4922d440340d3/apps/gateway/src/http/routes.ts#L524-L563
[new-after-payment]: https://github.com/nuanu-ai/agentify/blob/ae941b1dcbabe5313e5ab7d3a1a4922d440340d3/apps/gateway/src/http/routes.ts#L578-L598
[catalog-root]: https://github.com/nuanu-ai/agentify/blob/ae941b1dcbabe5313e5ab7d3a1a4922d440340d3/apps/gateway/src/http/server.ts#L108-L113
[catalog]: https://github.com/nuanu-ai/agentify/blob/ae941b1dcbabe5313e5ab7d3a1a4922d440340d3/apps/gateway/src/app/gateway.ts#L865-L904
[status-route]: https://github.com/nuanu-ai/agentify/blob/ae941b1dcbabe5313e5ab7d3a1a4922d440340d3/apps/gateway/src/http/routes.ts#L328-L348
[merchant-reads]: https://github.com/nuanu-ai/agentify/blob/ae941b1dcbabe5313e5ab7d3a1a4922d440340d3/packages/contracts/src/api.ts#L718-L734
[merchant-mutations]: https://github.com/nuanu-ai/agentify/blob/ae941b1dcbabe5313e5ab7d3a1a4922d440340d3/packages/contracts/src/api.ts#L750-L812
[dashboard-orders]: https://github.com/nuanu-ai/agentify/blob/ae941b1dcbabe5313e5ab7d3a1a4922d440340d3/apps/dashboard/app/routes/orders.tsx#L22-L38
[admin-routes]: https://github.com/nuanu-ai/agentify/blob/ae941b1dcbabe5313e5ab7d3a1a4922d440340d3/apps/dashboard/app/routes.ts#L37-L69
[operator-read]: https://github.com/nuanu-ai/agentify/blob/ae941b1dcbabe5313e5ab7d3a1a4922d440340d3/apps/gateway/src/ports/operator/orders-as-read.ts#L87-L103
[unique-key]: https://github.com/nuanu-ai/agentify/blob/ae941b1dcbabe5313e5ab7d3a1a4922d440340d3/apps/gateway/src/adapters/postgres/schema.ts#L263-L264
[duplicate-key]: https://github.com/nuanu-ai/agentify/blob/ae941b1dcbabe5313e5ab7d3a1a4922d440340d3/apps/gateway/src/adapters/postgres/store.ts#L1005-L1020
[where-stands]: https://github.com/nuanu-ai/agentify/blob/ae941b1dcbabe5313e5ab7d3a1a4922d440340d3/apps/gateway/src/app/gateway.ts#L3141-L3154
[compare-params]: https://github.com/nuanu-ai/agentify/blob/ae941b1dcbabe5313e5ab7d3a1a4922d440340d3/apps/gateway/src/app/gateway.ts#L2094-L2103
[compare-address]: https://github.com/nuanu-ai/agentify/blob/ae941b1dcbabe5313e5ab7d3a1a4922d440340d3/apps/gateway/src/app/gateway.ts#L2078-L2093
[erase-address]: https://github.com/nuanu-ai/agentify/blob/ae941b1dcbabe5313e5ab7d3a1a4922d440340d3/apps/gateway/src/app/runner.ts#L1758-L1771
[ended-payment]: https://github.com/nuanu-ai/agentify/blob/ae941b1dcbabe5313e5ab7d3a1a4922d440340d3/apps/gateway/src/app/gateway.ts#L1878-L1915
[adr48]: https://github.com/nuanu-ai/agentify/blob/ae941b1dcbabe5313e5ab7d3a1a4922d440340d3/docs/decisions/0048-an-attempt-that-lapsed-unpaid-is-deleted-after-thirty-days.md#L14-L20
[delete-lapsed]: https://github.com/nuanu-ai/agentify/blob/ae941b1dcbabe5313e5ab7d3a1a4922d440340d3/apps/gateway/src/adapters/postgres/store.ts#L1245-L1260
[adr27]: https://github.com/nuanu-ai/agentify/blob/ae941b1dcbabe5313e5ab7d3a1a4922d440340d3/docs/decisions/0027-recording-a-silent-charge.md#L15-L59
[unresolved-refusal]: https://github.com/nuanu-ai/agentify/blob/ae941b1dcbabe5313e5ab7d3a1a4922d440340d3/apps/gateway/src/app/gateway.ts#L3231-L3249
[adr43]: https://github.com/nuanu-ai/agentify/blob/ae941b1dcbabe5313e5ab7d3a1a4922d440340d3/docs/decisions/0043-the-purchase-door-refuses-before-any-charge.md#L23-L57
[admission]: https://github.com/nuanu-ai/agentify/blob/ae941b1dcbabe5313e5ab7d3a1a4922d440340d3/apps/gateway/src/adapters/postgres/store.ts#L968-L1003
[sale-checks]: https://github.com/nuanu-ai/agentify/blob/ae941b1dcbabe5313e5ab7d3a1a4922d440340d3/apps/gateway/src/app/gateway.ts#L1758-L1771
[payment-admission]: https://github.com/nuanu-ai/agentify/blob/ae941b1dcbabe5313e5ab7d3a1a4922d440340d3/apps/gateway/src/app/gateway.ts#L1956-L1979
[sync-park]: https://github.com/nuanu-ai/agentify/blob/ae941b1dcbabe5313e5ab7d3a1a4922d440340d3/apps/gateway/src/app/gateway.ts#L2147-L2224
[returning-flow]: https://github.com/nuanu-ai/agentify/blob/ae941b1dcbabe5313e5ab7d3a1a4922d440340d3/apps/gateway/src/app/gateway.ts#L1990-L2018
[returning-payment]: https://github.com/nuanu-ai/agentify/blob/ae941b1dcbabe5313e5ab7d3a1a4922d440340d3/apps/gateway/src/app/returning-payment.ts#L44-L171
[held-goods]: https://github.com/nuanu-ai/agentify/blob/ae941b1dcbabe5313e5ab7d3a1a4922d440340d3/apps/gateway/src/app/runner.ts#L1605-L1618
[wrong-payer]: https://github.com/nuanu-ai/agentify/blob/ae941b1dcbabe5313e5ab7d3a1a4922d440340d3/apps/gateway/src/http/routes.ts#L698-L711
[verify-advice]: https://github.com/nuanu-ai/agentify/blob/ae941b1dcbabe5313e5ab7d3a1a4922d440340d3/apps/gateway/src/app/gateway.ts#L2025-L2036
[partway-failure]: https://github.com/nuanu-ai/agentify/blob/ae941b1dcbabe5313e5ab7d3a1a4922d440340d3/apps/gateway/src/http/server.ts#L292-L307
[payee-snapshot]: https://github.com/nuanu-ai/agentify/blob/ae941b1dcbabe5313e5ab7d3a1a4922d440340d3/apps/gateway/src/app/gateway.ts#L1823-L1826
[challenge-payee]: https://github.com/nuanu-ai/agentify/blob/ae941b1dcbabe5313e5ab7d3a1a4922d440340d3/apps/gateway/src/http/routes.ts#L738-L759
[example-buyer]: https://github.com/nuanu-ai/agentify/blob/ae941b1dcbabe5313e5ab7d3a1a4922d440340d3/apps/docs/programs/buyer.mts#L52-L88
[dashboard-quickstart]: https://github.com/nuanu-ai/agentify/blob/ae941b1dcbabe5313e5ab7d3a1a4922d440340d3/apps/dashboard/app/screens/cards.tsx#L70-L83
[slice-buyer]: https://github.com/nuanu-ai/agentify/blob/ae941b1dcbabe5313e5ab7d3a1a4922d440340d3/packages/slice/src/buyer.ts#L138-L204
[buy-command]: https://github.com/nuanu-ai/agentify/blob/ae941b1dcbabe5313e5ab7d3a1a4922d440340d3/packages/slice/src/buy.ts#L203
[smoke-command]: https://github.com/nuanu-ai/agentify/blob/ae941b1dcbabe5313e5ab7d3a1a4922d440340d3/packages/slice/src/smoke.ts#L288
[split-command]: https://github.com/nuanu-ai/agentify/blob/ae941b1dcbabe5313e5ab7d3a1a4922d440340d3/packages/slice/src/split-smoke.ts#L346-L352
[bootstrap-buyer]: https://github.com/nuanu-ai/agentify/blob/ae941b1dcbabe5313e5ab7d3a1a4922d440340d3/packages/slice/src/bootstrap-command.ts#L1156-L1201
[stand-buyer]: https://github.com/nuanu-ai/agentify/blob/ae941b1dcbabe5313e5ab7d3a1a4922d440340d3/packages/slice/src/stand-buyer.ts#L183-L221
[purchase-contract]: https://github.com/nuanu-ai/agentify/blob/ae941b1dcbabe5313e5ab7d3a1a4922d440340d3/packages/contracts/src/api.ts#L236-L258
[repeat-docs]: https://github.com/nuanu-ai/agentify/blob/ae941b1dcbabe5313e5ab7d3a1a4922d440340d3/apps/docs/orders.md#L665-L689
[failure-docs]: https://github.com/nuanu-ai/agentify/blob/ae941b1dcbabe5313e5ab7d3a1a4922d440340d3/apps/docs/failures.md#L27-L30
[quickstart-docs]: https://github.com/nuanu-ai/agentify/blob/ae941b1dcbabe5313e5ab7d3a1a4922d440340d3/apps/docs/quickstart.md#L438-L470
[llms]: https://github.com/nuanu-ai/agentify/blob/ae941b1dcbabe5313e5ab7d3a1a4922d440340d3/apps/web/lib/llms.ts#L79
[llms-test]: https://github.com/nuanu-ai/agentify/blob/ae941b1dcbabe5313e5ab7d3a1a4922d440340d3/apps/web/lib/llms.test.ts#L61-L68
[portal-fixtures]: https://github.com/nuanu-ai/agentify/blob/ae941b1dcbabe5313e5ab7d3a1a4922d440340d3/packages/contracts/src/portal-fixtures.test.ts#L1-L21
[buyer-tests]: https://github.com/nuanu-ai/agentify/blob/ae941b1dcbabe5313e5ab7d3a1a4922d440340d3/packages/slice/src/quickstart-buyer.test.ts#L1-L17
[portal-fences]: https://github.com/nuanu-ai/agentify/blob/ae941b1dcbabe5313e5ab7d3a1a4922d440340d3/packages/sdk/src/portal-fences.test.ts#L17-L22
[portal-tables]: https://github.com/nuanu-ai/agentify/blob/ae941b1dcbabe5313e5ab7d3a1a4922d440340d3/packages/core/src/orders/portal-tables.test.ts#L436-L459
[adr12]: https://github.com/nuanu-ai/agentify/blob/ae941b1dcbabe5313e5ab7d3a1a4922d440340d3/docs/decisions/0012-discovery-declaration.md#L48-L68
[discovery-builder]: https://github.com/nuanu-ai/agentify/blob/ae941b1dcbabe5313e5ab7d3a1a4922d440340d3/apps/gateway/src/http/x402.ts#L281-L301
[requirements]: https://github.com/nuanu-ai/agentify/blob/ae941b1dcbabe5313e5ab7d3a1a4922d440340d3/apps/gateway/src/http/x402.ts#L164-L179
[facilitator]: https://github.com/nuanu-ai/agentify/blob/ae941b1dcbabe5313e5ab7d3a1a4922d440340d3/apps/gateway/src/adapters/x402/facilitator.ts#L118-L125
[merchant-projection]: https://github.com/nuanu-ai/agentify/blob/ae941b1dcbabe5313e5ab7d3a1a4922d440340d3/apps/gateway/src/app/runner.ts#L1621-L1635
[analytics]: https://github.com/nuanu-ai/agentify/blob/ae941b1dcbabe5313e5ab7d3a1a4922d440340d3/apps/gateway/src/app/order-analytics.ts#L50-L62
[caddy]: https://github.com/nuanu-ai/agentify/blob/ae941b1dcbabe5313e5ab7d3a1a4922d440340d3/deploy/Caddyfile#L44-L51
[boundary-test]: https://github.com/nuanu-ai/agentify/blob/ae941b1dcbabe5313e5ab7d3a1a4922d440340d3/apps/gateway/src/http/buyer-key.test.ts#L54-L111
[woo-known]: https://github.com/nuanu-ai/agentify/blob/ae941b1dcbabe5313e5ab7d3a1a4922d440340d3/apps/dashboard/src/woo-worker.ts#L188-L207
[woo-claim]: https://github.com/nuanu-ai/agentify/blob/ae941b1dcbabe5313e5ab7d3a1a4922d440340d3/apps/dashboard/src/woo-worker.ts#L309-L334
[legacy-key]: https://github.com/nuanu-ai/agentify/blob/ae941b1dcbabe5313e5ab7d3a1a4922d440340d3/apps/gateway/drizzle/0028_order_buyer_key.sql#L7-L25
[stored-key]: https://github.com/nuanu-ai/agentify/blob/ae941b1dcbabe5313e5ab7d3a1a4922d440340d3/apps/gateway/src/ports/store.ts#L219-L228
[adr6]: https://github.com/nuanu-ai/agentify/blob/ae941b1dcbabe5313e5ab7d3a1a4922d440340d3/docs/decisions/0006-wire-version.md#L9-L61
[contract-version]: https://github.com/nuanu-ai/agentify/blob/ae941b1dcbabe5313e5ab7d3a1a4922d440340d3/packages/contracts/src/index.ts#L297
[sdk-version]: https://github.com/nuanu-ai/agentify/blob/ae941b1dcbabe5313e5ab7d3a1a4922d440340d3/packages/sdk/src/contract.ts#L9-L21
[http-harness]: https://github.com/nuanu-ai/agentify/blob/ae941b1dcbabe5313e5ab7d3a1a4922d440340d3/apps/gateway/src/testing/harness.ts#L383-L415
[direct-begin]: https://github.com/nuanu-ai/agentify/blob/ae941b1dcbabe5313e5ab7d3a1a4922d440340d3/apps/gateway/src/http/buyer-key.test.ts#L135-L138
[randomness]: https://github.com/nuanu-ai/agentify/blob/ae941b1dcbabe5313e5ab7d3a1a4922d440340d3/apps/gateway/src/ports/clock.ts#L21
[payment-tests]: https://github.com/nuanu-ai/agentify/blob/ae941b1dcbabe5313e5ab7d3a1a4922d440340d3/apps/gateway/src/http/payment-order.test.ts#L1
[return-tests]: https://github.com/nuanu-ai/agentify/blob/ae941b1dcbabe5313e5ab7d3a1a4922d440340d3/apps/gateway/src/http/paid-purchase-return.test.ts#L132-L173
[status-tests]: https://github.com/nuanu-ai/agentify/blob/ae941b1dcbabe5313e5ab7d3a1a4922d440340d3/apps/gateway/src/http/order-status.test.ts#L1
[door-tests]: https://github.com/nuanu-ai/agentify/blob/ae941b1dcbabe5313e5ab7d3a1a4922d440340d3/apps/gateway/src/http/purchase-door.test.ts#L1
[store-tests]: https://github.com/nuanu-ai/agentify/blob/ae941b1dcbabe5313e5ab7d3a1a4922d440340d3/apps/gateway/src/testing/store-contract.ts#L1
