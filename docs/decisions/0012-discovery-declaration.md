# 0012. The payment challenge declares the product, as a projection of its card

Date: 2026-08-27
Status: accepted (the product owner)

## Context

ADR-0001 exposes the product on the x402 Bazaar, a discovery catalog that lists
an endpoint once its payment challenge carries a discovery declaration and a
payment to it settles through the CDP facilitator
(`docs/research/04-spike-bazaar-listing.md`). A card already holds almost
everything a declaration wants.

## Decision

The declaration is a projection of a card, `bazaarDeclarationOf` in
`packages/contracts/src/card.ts`, beside the projection an agent reads in our
own catalog: the resource block, an example purchase body, the JSON Schema that
body is held to, and an example of what the agent receives. A parcel's body and
schema carry `ship_to`, and its example output is a recorded shipment. Examples
stand for each declared type and carry no invented data. The wire format is
assembled at the edge by the protocol's own library, never by hand, and
`@x402/extensions` is the gateway's dependency alone, since ADR-0003 §8 keeps
the contracts package, on which the merchant SDK depends, to zod. The resource
address is pinned from `PUBLIC_BASE_URL` and the route table, never read off the
request, which behind our reverse proxy arrives as `http://` with the caller's
query string: a catalog keys a listing on the address, and two spellings would
be two listings for one product.

The listing name belongs to the merchant and the tags to the card, since a name
per card would show one seller as several. The merchant sets the name in the
dashboard or through the API, the operator can take it away, and it is never
filled in from the display name, which may be in any alphabet where the listing
name goes out under the catalog's ASCII rule. Merchant-written text is held at
the publish to the catalog's limits, by the catalog's own code where that code
can be run, because the catalog drops what breaks them without telling anybody.

Every card is declared, with no opt-in, and only while it is for sale: a card
off sale for any reason answers no challenge, so the catalog never carries a
product nobody can buy. The declaration describes the purchase, a POST with a
JSON body, whichever method asked for the challenge. An unpaid call with no
document, a GET or a POST with nothing or an empty one, gets the challenge,
which is how the catalog's validator asks and what it accepts
(`docs/research/26-discovery-method-on-get.md`); a document of the wrong shape
is refused with its fields before anything is signed. Whether the crawler
accepts it at a real listing only a real listing shows, and that is the exit
condition of this rule.

## Consequences

Our tests hold the declaration to the library's schema and a shape accepted
once, which is not acceptance; `pnpm smoke:listing` makes the live call with the
purchase's method and reports a probe with no verdict as no verdict. The
catalog's limits belong to the card schema the publish and read paths share, so
a stored card that breaks a newer limit is unreadable until republished, except
under ADR-0017's plain-text rule, held at the publish alone. A name in Cyrillic,
Greek or Arabic cannot be a listing name, and the merchant is told so here
rather than dropped silently by the catalog. The declaration rides in one
challenge header that grows with the card.

Rejected: an opt-in flag, making invisibility the default this decision exists
to leave; the display name as the listing name, which puts one catalog's
alphabet rule on every merchant's name; and declaring the GET a crawler probes
with, which tells an agent that paying the GET delivers the product; one agent
paid it.