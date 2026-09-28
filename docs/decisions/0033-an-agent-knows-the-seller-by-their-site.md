# 0033. An agent knows who sells by a name and the shop's own site

Date: 2026-09-28
Status: accepted. Not built yet.

## Context

The storefront names nobody. A card and an order say what is sold and for how
much, not by whom; the public card's own description says that who the
merchant is to the buyer was left open (`packages/contracts/src/card.ts`). The
one name a merchant has is the one a discovery catalog lists them under. An
agent with a question the order cannot answer — a parcel that did not arrive
(ADR-0032), a return, the terms of what it bought — has nowhere to take it.
A support channel or a merchant profile of our own would bring into Agentify
what the merchant's site already carries.

## Decision

A merchant names once, in the cabinet, the address of their shop's own site:
an `https` address and nothing else. The agent reads it beside the seller name
on every card of that merchant in our catalog and on the status of every
order, under a description saying the merchant gave it and Agentify did not
check it. How to reach the shop, its terms and its returns are for the agent to
read there. A card that ships goods is not published without it; on any other
card it appears where the merchant has named one. Nothing else about the
merchant is kept for the agent. The storefront's documents gaining these fields
is what ADR-0006 §5 allows.

## Consequences

Agentify takes on no support channel and no profile to keep true: the agent is
sent where the rest of the web would send it. An address we did not check can
be anybody's, which is why the agent is told whose word it is; checking it, for
instance by a file the site serves, is a later decision. The seller's name,
until now a discovery catalog's field, becomes what our own catalog shows too.

Rejected: a support contact, per merchant or per shipment (a channel we would
have to keep true, and absent where a merchant never gave one); free text about
the shop (the site already says it, and text written for agents is a way to
hand them instructions); nothing (an agent with a lost parcel would have
nowhere to go); verifying the address now (a mechanism before anybody has
asked for it, where marking the word costs nothing).
