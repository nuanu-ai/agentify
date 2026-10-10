# 0006. What the contract version promises, and when it moves

Date: 2026-08-27
Status: accepted; revised on the product owner's word, last on 2026-10-09

## Context

The SDK reads every gateway answer strictly against its own schemas, and
`speaksContract` requires the gateway's `CONTRACT_VERSION` to equal its own on
every poll, so an older SDK takes a newer word for an unreadable document. The
storefront's reader is different: a stranger's agent that no handshake reaches.

## Decision

1. Version `"0"` means unreleased: nobody runs a published SDK, nothing is
   promised, and a wire-visible change does not move it.
2. The version is `"2"`, and moves from the first merchant we do not control.
   From the day such a merchant runs a published SDK, a change a strict reader
   cannot read (a new value in a response enum, a new required field, a renamed
   or removed one) moves it, so an old worker stops at startup with a clear
   message rather than misreporting its successes. Until then it holds, since a
   move would stop only our own workers, which are upgraded with the gateway.
   Which merchant is the first is the product owner's word, and the change that
   serves them says so here. The exception is what no SDK worker reads: the
   payout wallet's pending fields (ADR-0019), and the routes and refusal codes
   only the dashboard called, which left the contract with its key
   (ADR-0030). Such a change leaves the version alone, and an older contracts
   package refuses it until upgraded.
3. The published SDK stays strict. Even a result word beside `ok: true`, which
   informs rather than directs, is in the generated schema and the typed result
   a merchant records, so from the first merchant we do not control (§2) every
   new value moves the version before the gateway sends it, and the handshake
   refuses it at worker startup, with no order in flight. Until then an older
   SDK can read a newer word as a failure; the portal tells merchants to keep
   the package current. An open string for unknown words is rejected: it would
   silently open one part of a closed contract and move the compatibility rule
   from the version boundary into every consumer.
4. `/v0/` names the merchant's API and nothing else: a shop's code is written
   against those addresses, and the prefix moves on the day that surface
   changes shape. The prefix names which calls exist where, `CONTRACT_VERSION`
   names the vocabulary and documents flowing through them, and neither derives
   from the other. Every JSON Schema the contracts package renders is
   identified as `urn:agentify:contract:${CONTRACT_VERSION}:${name}`, so moving
   the version moves every schema's identity, and the prefix plays no part.
5. The storefront carries no version. The catalog, the address an agent buys
   at and the door it returns to for its order live at `/x402/…`: a discovery
   catalog keys a listing on its address, and a stranger's agent builds that
   address from parts it read elsewhere, so the address has to outlive every
   dialect we speak. Protocol evolution rides in band, in the challenge's
   `x402Version` field, as it does across the paid storefront genre
   (`docs/research/04-spike-bazaar-listing.md`). A version segment is rejected:
   each move would retire a listed resource for one that a catalog lists only
   after its own first paid purchase and ranks from zero, to say what the
   challenge can say in a field.

   Its vocabularies are therefore open in its schemas. A card's fulfillment
   mode and an order's status, on the catalog and the agent's status document,
   are strings with their known values listed beside them: a card of an unknown
   mode is skipped and the rest of the page stands, and an unknown status is
   not an ending the agent knows, so it asks again later without buying again.
   §3's rejection does not reach here: no version can stop a stranger's agent
   with words, so a closed list would only break it silently. The storefront's
   documents and every part inside them (the seller, a price, a declared field,
   a merchant's refusal) take fields added later, which an agent ignores, while
   a gateway writes only the fields and words its version names, because a
   reader that ignores the unknown cannot refuse a field that leaked. A word
   inside a part, the type of a declared field, stays a closed list: a card
   with a type an agent does not know cannot be filled in and is passed over.
   The merchant's schemas stay closed. ADR-0033's `ship` and `shipped`,
   ADR-0034's seller name and site, and an order status's `reason` are added
   under this rule.

## Consequences

From the first merchant we do not control, an installed SDK reads the whole
vocabulary it was built for or stops before polling an order, at the price of a
version move and a coordinated gateway delivery for even an additive result. A
listed address is earned once and never retired, so a breaking change to the
purchase is carried there or announced in band. Whether a catalog still lists
anything under `/v0/items/…` is not known; `pnpm smoke:listing` is what asks.
