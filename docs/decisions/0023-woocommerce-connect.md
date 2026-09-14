# 0023. A connected WooCommerce shop is a merchant's credential we hold and fill orders with

Date: 2026-09-14
Status: accepted

## Context

A merchant whose products live in a WooCommerce shop has a catalogue, a way of
being paid and no code. The probe on `spikes/woo/` established that all three
pieces of a channel exist on a stock self-hosted shop and need no plugin of
ours: the 2015 wc-auth grant still hands out working keys, the Store API serves
the catalogue with no authentication at all, and `wc/v3` creates an order the
shop itself calls paid (`docs/research/27-woo-connect-probe.md`). Opening that
channel puts two things into this system that were not in it before, and both
are expensive to reverse.

The first is somebody else's credential at rest in our database. The second is
a route anybody on the internet may post to: the grant is completed by the
shop's own web server posting the freshly minted key pair to an address we
supplied, carrying no session of ours and no key of ours, because that is what
wc-auth is.

## Decision

**The shop's key and secret are kept by the cabinet, in a row, as the shop
issued them.** This is the shape ADR-0014 §2 already argues for the merchant key
on an account row, and the argument carries with one difference said out loud:
the secret is a third party's. What a copy of this table buys is write access to
a stranger's shop until they revoke it — which they can do themselves, from
WooCommerce → Settings → Advanced → REST API, where the key appears under the
name we asked for it under. It is not a secret store; the database is a boundary
against the network and not against a host, and the day that stops being enough
the fix is one, not a cleverer column.

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

What this adds to the public surface is nothing — no route, no contract, no
field — and four screens behind the sign-in. What it adds to ours is three
tables and one process in the cabinet that is not a page.

**Whose address goes on the order in the shop is not decided.** Creating an
order makes WooCommerce send mail to the address on it and to the shop
administrator, and nothing in the request can suppress either. Until somebody
decides what a buyer's agent's address means here — an agent may have none, and
handing a stranger's address to a merchant's mailing list is a decision and not
a default — the address used is the merchant's own account address. So a
merchant gets both emails, and no buyer gets one.

**An attempt whose outcome we never learned refuses the sale.** The ledger row
with no order number on it means a request went towards the shop and nothing
came back; whether that shop holds an order is not knowable from here, so the
next hand-over is refused in words that say so rather than ordering again. The
cost is a refused sale where the shop had nothing; the alternative is a second
thing a merchant picks, packs and posts for one payment.

**An import brings over at most two hundred products.** Every one is a separate
call to the publish door made while somebody holds a page open. A larger
catalogue is refused with that sentence rather than being handed its first two
hundred as though that were all of it.

**Rejected: a plugin of ours in the merchant's shop.** It is the thing every
competitor ships and it is a second codebase in someone else's WordPress, with
its own update path and its own security surface, for a channel that works
without one. **Rejected: creating the order from the gateway.** The gateway
would then need a stranger's shop credentials and two new routes for the cabinet
to put them there, which is a wider public surface and a second place the same
secret lives. **Rejected: a signed state token instead of a row.** A signature
proves who issued a value and cannot make it single-use, and single-use is the
half that matters here.
