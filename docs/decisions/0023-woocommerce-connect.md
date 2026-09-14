# 0023. A connected WooCommerce shop is a merchant's credential we hold and fill orders with

Date: 2026-09-14
Status: accepted

## Context

A merchant whose products live in a WooCommerce shop has a catalogue, a way of
being paid and no code. The probe on `spikes/woo/` established that every piece
of a channel exists on a stock self-hosted shop and needs no plugin of ours: the
wc-auth grant hands out working keys, the Store API serves the catalogue
unauthenticated, and `wc/v3` creates an order the shop itself calls paid
(`docs/research/27-woo-connect-probe.md`). Opening it puts two things into this
system that were not in it before, and both are expensive to reverse: somebody
else's credential at rest in our database, and a route anybody on the internet
may post to, because the grant is completed by the shop's own web server posting
the key pair to an address we supplied.

## Decision

**The shop's key and secret are kept by the cabinet, in a row, as the shop
issued them.** This is the shape ADR-0014 §2 argues for the merchant key on an
account row, with one difference said out loud: the secret is a third party's.
What a copy of this table buys is write access to a stranger's shop until they
revoke it — which they can do themselves, from WooCommerce → Settings → Advanced
→ REST API, where the key appears under the name we asked for it under. It is
not a secret store; the database is a boundary against the network and not
against a host, and the day that stops being enough the fix is one, not a
cleverer column.

**The callback is guarded by a one-time state token and by nothing else.**
wc-auth's `user_id` is an opaque string of the application's choosing, handed
back in the callback and in the return redirect. Ours is thirty-two random bytes
written down when the merchant presses Connect, bound to their account and to
the shop address they typed and we checked, good for fifteen minutes, and
deleted by arriving — so a token that worked cannot work again, and a request
carrying anything else is refused with a status rather than a page, which makes
the shop take the key it minted back out (`class-wc-auth.php`,
`maybe_delete_key`). The shop address is read off the row and never off the
callback: read off the callback it would be a shop of the caller's choosing.

**Orders are filled by the cabinet acting as that merchant's worker, over the
public merchant API.** No private arrangement with the gateway and no new wire:
the hand-over is the gateway's own queue-shaped effect, written into the same
transaction as the state that implies it (ADR-0013), and the cabinet draws it
with that merchant's key like any worker. A sale is claimed in a ledger before
the shop is called, so a redelivery places no second order.

## Consequences

This adds nothing to the public surface — no route, no contract, no field — and
four screens behind the sign-in. To ours it adds three tables and one process in
the cabinet that is not a page.

**Whose address goes on the order in the shop is not decided.** Creating an
order makes WooCommerce mail the address on it and the shop administrator, and
nothing in the request can suppress either. Until somebody decides what a
buyer's agent's address means here — an agent may have none, and handing a
stranger's address to a merchant's mailing list is a decision, not a default —
the address used is the merchant's own. So a merchant gets both emails and no
buyer gets one.

**An attempt whose outcome we never learned refuses the sale.** A ledger row
with no order number means a request went towards the shop and nothing came
back; whether that shop holds an order is not knowable from here, so the next
hand-over is refused in words that say so. The cost is a refused sale where the
shop had nothing; the alternative is a second thing a merchant picks, packs and
posts for one payment.

**An import brings over at most two hundred products, and takes nothing off
sale.** Every product is a separate call to the publish door while somebody
holds a page open. A product deleted in the shop, or out of stock, is simply
absent from what is read, and the card published for it earlier stays where it
is; the screen says so, and pausing it is one press.

**The preflight is an outgoing request to an address the merchant chose.** A
registered merchant can make the cabinet fetch any https address and learn
whether it answered and, on a 401, one line of what it said. https narrows it,
and the alternative — refusing private addresses — would refuse the laboratory
in `spikes/woo/` with them. It is priced here rather than guarded, and the guard
is owed the day this cabinet shares a network with something that answers https
and should not be asked. Nothing bounds the number of connected shops either:
one loop and one held request per shop is what keeps one merchant's orders from
waiting behind another's, and at some number it is the wrong shape.

**Rejected: a plugin of ours in the merchant's shop.** Every competitor ships
one; it is a second codebase in somebody else's WordPress, with its own update
path and its own security surface, for a channel that works without it.
**Rejected: creating the order from the gateway.** It would then need a
stranger's shop credentials and two new public routes for the cabinet to put
them there — a wider surface and a second place the same secret lives.
**Rejected: a signed state token instead of a row.** A signature proves who
issued a value and cannot make it single-use, which is the half that matters.
