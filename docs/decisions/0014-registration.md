# 0014. Registration makes a merchant and its dashboard's key in one act

Date: 2026-08-28
Status: accepted (the product owner, 2026-08-28; 2026-09-25: every registration
path except the one main path is removed)

## Context

The dashboard served exactly one merchant, through one key read at start-up, so
a second account was a second person looking at the first merchant's money.
And the public catalogue is one across merchants by decision (ADR-0010), so a
registration form nobody has to get past puts a stranger's words in front of
every buyer. Registration therefore needs tenancy and a door, and neither may
wait for perfection: the road's order is ADR-0010's.

## Decision

There is one way in. An account comes into being when a person types their
address, opens the link mailed to it and presses the button on the page it
opens (ADR-0026 §1); a merchant, when that signed-in person presses the one
control the dashboard offers (§1). No command at a server's terminal makes an
account, a merchant or a key, and no deployed channel's gateway seeds a
merchant at start-up: the release refuses a channel configured to. The
operator's terminal looks after what exists — lists merchants, keys and
accounts, disables a key, takes a listing name away, ends a person's sessions,
moves the operator flag, approves live sales. Only the laptop's stack seeds its
sandbox merchant, so that one command brings it up selling (ADR-0010).

**1. The account is written at sign-in, the merchant and its key on the
dashboard's explicit request.** The account appears when a one-time link is
consumed for an address that has none (ADR-0026 §1), and no form asks for a
password or an invitation. The merchant and the key its dashboard calls with are
made later, when the signed-in person presses the one control the dashboard
offers (ADR-0026 §4). That act crosses the boundary once and each side writes
in one transaction: the gateway makes the merchant and the key, the dashboard
writes the merchant on the person. A gateway that does not answer leaves the
person signed in without a merchant, pressing again from inside the session
rather than spending another link; a dashboard that fails after the gateway
answered leaves a merchant nobody names — litter, not damage, and the next
attempt makes a new one.

**2. An account names its merchant and holds a key made for the dashboard.** The
dashboard builds its gateway client per request from the signed-in account's
row; `MERCHANT_API_KEY` leaves the configuration. The key is stored as issued,
and it is made afresh at every sign-in and at most once a day, when a visit
extends the session, and the one it replaces forgotten — so a key in a copy of
the database stops working by its account's first visit more than a day after
the copy was taken, while an account that never returns keeps its key working.
The session is extended at most once a day by whichever reading of it comes
first, a dashboard page or the scanner's question about a cookie, so a day spent
only on reports renews the key too. A session lasts thirty days from the last
visit (ADR-0026 §2), and without the daily renewal that bound would stretch
with it. Each renewal is also one more chance
to leave behind a key of the kind an interrupted sign-in leaves (§5), and
nothing clears those yet. It is still not a secret store; the
database is a boundary against the network, not against a host, and the day
that stops being enough the fix is one, not a cleverer column.

**3. The registration route is internal, behind an invitation code.** Only
the dashboard calls it, at the gateway's listener in the process the two
share (ADR-0030), and the site answers it from outside as a path it does not
have, as it answers the two calls at `/v0/keys/dashboard` (§5): the code is a
value in the application's configuration guarding a wire inside it,
and a copy of that configuration must not be a way to make a merchant. People
never type it; ADR-0026 retired it for them, and the door stands at live
publication. What follows is why the route is built as it is. The route
takes no key — nobody registering has one. A wrong code and a closed
registration answer identically, in constant time against a decoy (the two
answers that must be indistinguishable are the two refusals), so the form does
not say whether registration is open, only whether this code is the one. The
door retires when a confirmed address replaces it (ADR-0026 §1).

**4. The name buyers see is asked for after registering, never on the form.**
It is a public answer demanded at the moment a merchant knows least, so it
lives on its own screen and in settings, changeable. Publishing a card while
it is unset is refused with a sentence naming where to set it: a card with no
seller reaches an agent inside a payment challenge that names nobody.

**5. Keys are made and disabled from the dashboard, and a key says what it is
for.** Three merchant-scoped routes over the keys a merchant made for their own
code — list, issue, disable — and two at `/v0/keys/dashboard` that make a key for
a dashboard and forget one, refused to any other key and reachable only inside
the stack, so that a copied dashboard key cannot mint another from outside that
no renewal ever forgets. That kind is in no
merchant's list and is refused by the disabling, since a merchant switches off
what they issued; forgetting removes rather than revokes. The forgetting takes
the key the call was made with and no other: a rule of the form "every key but
this one" is decided when the call is sent and stale when it lands, so a key
written in between is removed by a caller that never heard of it, and two
overlapping sign-ins leave an account naming a key that is gone. Reaching only
the key in the caller's hand, nobody can take away a credential anybody else
holds. What that costs is that nothing sweeps up after an interrupted sign-in;
clearing those by age is counted from the dashboard, which knows the keys still in
use, and is not built — the gateway now records when a key was last called, but
a dashboard key nobody has used is as likely to be the one on the row of a person
who has not signed in for a while, and removing that locks them out from the
outside, so the age that decides is the dashboard's. A merchant cannot disable the
key their own call was made with — a rule in the route, because that click
leaves whoever made it calling with something the gateway no longer takes. It
sees the key on the call, so two keys disabling each other in one moment still
leave a merchant with none of their own, which nobody has decided to refuse;
the way back in is a key of the other kind.

## Consequences

The dashboard is multi-tenant; the process-wide client and its variable are
gone. A person who has only signed in owns no merchant yet (ADR-0026 §4); one
who has asked the dashboard for one owns exactly one, and
a merchant who has only ever signed in has no keys of their own. Not built and not pretended: a second
person at a merchant, roles, deleting a merchant.

## Alternatives rejected

**A merchant or an account made at the terminal.** Commands that made a
merchant with no account, wrote a key for it straight into the database, and
wrote an account for an existing merchant from a key piped in were a second
door beside the mailed link: a merchant nobody could sign in as, a key no
announcement covered (ADR-0019), an account whose address nobody had proved.
What they were for is what the one way in does: a person who needs an
account signs in, and a merchant who has lost every key signs in, which
renews the dashboard's own, and issues a new one there.
**Seeding a merchant on a deployed channel.** A key in a host's file, written
into the database at every start, is a merchant nobody registered and a
credential nobody can retire without a release: disabling its row stops it,
and a database brought up from nothing is seeded off the same line again.
**Open registration.** Not before an address means something: the catalogue is
shared, and the first cost of a stranger's words is the buyer's, not ours.
**Wait for mail, build nothing.** Everything here is needed whichever the door
is; only the door changes. **One privileged dashboard key naming the merchant
per request.** The same secret with a second authentication mode on the money
path (ADR-0005 §2), plus a "which merchant" parameter somebody forgets to
check. **Encrypting the stored key.** Moves the secret into the same process
configuration and calls it protected; a secret store is the real answer, bought
when there is something to protect that is not a sandbox. **Registration on
the gateway.** A public form, a password and a rate limit on the money path,
and the gateway would need the account table this decision keeps out of it.
