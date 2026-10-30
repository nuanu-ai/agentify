# 0034. An agent knows who sells by a name and the shop's own site

Date: 2026-09-28
Status: accepted (the product owner, 2026-09-28); the site requirement for
asynchronous purchases is approved on 2026-10-27; filling an empty site from a
confirmed WooCommerce connection is approved on 2026-10-30.

## Context

The storefront names nobody. A card and an order say what is sold and for how
much, not by whom; the public card's own description says that who the
merchant is to the buyer was left open (`packages/contracts/src/card.ts`). The
one name a merchant has is the one a discovery catalog lists them under. An
agent with a question the order cannot answer — a parcel that did not arrive
(ADR-0033), a return, the terms of what it bought — has nowhere to take it.
A support channel or a merchant profile of our own would bring into Agentify
what the merchant's site already carries.

## Decision

A merchant gives, beside their seller name in the dashboard's settings and
through the call that sets the name, the address of their shop's own site. A
confirmed WooCommerce connection with read and write access also fills an empty
site from the connected shop's origin; it never replaces an existing site. A
failed site write leaves the connection intact and offers a retry. An origin
that fails the site rule leaves the site empty and points to Settings. The site is an
`https` origin, the scheme and a domain name — not an IP address or a single
word — with no path, query, fragment, port or credentials, refused at the door
in any other form. The agent reads both on every card of that merchant in our
catalog and on the status of every order, as a `seller` object of `name` and
`site`, under a description saying the merchant gave them and Agentify did not
check them; `site` is `null` where the merchant has given none. The name keeps
its rule of at most 32 characters of printable ASCII, and this decision holds
it to the plain-text rule of ADR-0017 as well. How to reach the shop, its
terms and its returns are for the agent to read on the site. An asynchronous
or parcel card, paid before delivery, requires a site to be published. The
refusal is a finding, `no_seller_site`, naming where to set it. Such a card
without a site leaves the catalogue and refuses a new purchase before its price
is asked, and a price already given for it is refused when its payment arrives,
before the payment is checked. Supplying a site restores eligibility without
republishing. Already accepted payments, paid recovery and fulfillment
continue. A synchronous card may sell without a site. Nothing else about the
merchant is kept for the agent. The storefront's documents gaining these
fields is what ADR-0006 §5 allows.

## Consequences

Agentify takes on no support channel and no profile to keep true: the agent is
sent where the rest of the web would send it. A name and a site we did not
check can be anybody's — "Amazon" with `https://www.amazon.com` passes — which
is why the agent is told whose word they are; checking the site, for instance
by a file it serves, is a later decision. The seller's name, until now a
discovery catalog's field, becomes what our own catalog shows too.

Rejected: a support contact, per merchant or per shipment (a channel we would
have to keep true, and absent where a merchant never gave one); free text about
the shop (the site already says it, and text written for agents is a way to
hand them instructions); a full address with a path or a query (the same free
text by another name); nothing (an agent with a lost parcel would have nowhere
to go); verifying the site now (a mechanism before anybody has asked for it,
where marking the word costs nothing); a separate machine-readable refund and
remedy policy now (the existing site lets the buyer read the merchant's terms
without another public schema; a missing policy stays unknown).
