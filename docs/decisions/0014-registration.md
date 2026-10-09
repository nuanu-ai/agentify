# 0014. Registration makes a merchant for the person who asked

Date: 2026-08-28
Status: accepted (the product owner, 2026-08-28; 2026-09-25: every registration
path except the one main path is removed; 2026-10-09: the key made for a
dashboard and the registration route are deleted with ADR-0030)

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

**1. The account is written at sign-in, the merchant on the dashboard's explicit
request.** The account appears when a one-time link is consumed for an address
that has none (ADR-0009 §5), and no form asks for a password or an invitation.
The merchant is made later, when the signed-in person presses the one control
the dashboard offers (ADR-0026 §4). The press calls the gateway inside the
process the two share (ADR-0030), and each side writes in a transaction of its
own: the gateway makes the merchant, with no key, and the dashboard writes its
identifier on the person. A database that does not answer leaves the person
signed in without a merchant, pressing again from inside the session rather than
spending another link; a dashboard that fails after the gateway made the
merchant leaves a merchant nobody names — litter, not damage, and the next
attempt makes a new one.

**2. An account names its merchant, and holds nothing else of it.** The
dashboard calls the gateway's application as the merchant on the signed-in
account's row (ADR-0030), so two accounts are two merchants; `MERCHANT_API_KEY`
left the configuration with the process-wide client. The row holds the
merchant's identifier and no credential: the dashboard calls with none, so a
copy of its database is not a way into the API.

**3. Nothing at the door makes a merchant.** The press is a call inside the
process (§1), so the gateway has no registration route and no invitation
setting, and a host's configuration carries no code. People never type one;
ADR-0026 retired it for them, and the door that keeps a stranger's words out
of the catalogue stands at live publication.

**4. The name buyers see is asked for after registering, never on the form.**
It is a public answer demanded at the moment a merchant knows least, so it
lives on its own screen and in settings, changeable. Publishing a card while
it is unset is refused with a sentence naming where to set it: a card with no
seller reaches an agent inside a payment challenge that names nobody.

**5. Keys are made and disabled from the dashboard.** Three merchant-scoped
routes over a merchant's keys — list, issue, disable — which a merchant's own
code calls over the API, and which the dashboard reaches as the same
operations, called inside the process as a signed-in person (ADR-0030). Every
key is one the merchant issued, so the list is all of them, the key a call
over the API was made with included. A call over the API cannot disable the
key it was made with — a rule in the route, because that click leaves whoever
made it calling with something the gateway no longer takes; a session in the
dashboard holds no key, so every key on its list can be disabled there. The
rule sees the key on the call, so two keys disabling each other in one moment
still leave a merchant with none, which nobody has decided to refuse; the way
back in is the mailed link.

## Consequences

The dashboard is multi-tenant; the process-wide client and its variable are
gone. A person who has only signed in owns no merchant yet (ADR-0026 §4); one
who has asked the dashboard for one owns exactly one, and a merchant who has
only ever signed in has no keys. Not built and not pretended: a second person at
a merchant, roles, deleting a merchant.

## Alternatives rejected

**A merchant or an account made at the terminal.** Commands that made a merchant
with no account, wrote a key for it straight into the database, and wrote an
account for an existing merchant from a key piped in were a second door beside
the mailed link: a merchant nobody could sign in as, a key no announcement
covered (ADR-0019), an account whose address nobody had proved. What they were
for is what the one way in does: a person who needs an account signs in, and a
merchant who has lost every key signs in with a mailed link and issues a new one
there. **Seeding a merchant on a deployed channel.** A key in a host's file,
written into the database at every start, is a merchant nobody registered and a
credential nobody can retire without a release: disabling its row stops it, and
a database brought up from nothing is seeded off the same line again. **Open
registration.** Not before an address means something: the catalogue is shared,
and the first cost of a stranger's words is the buyer's, not ours. **Wait for
mail, build nothing.** Everything here is needed whichever the door is; only the
door changes. **One privileged dashboard key naming the merchant per request.**
The same secret with a second authentication mode on the money path (ADR-0005
§2), plus a "which merchant" parameter somebody forgets to check. **A
registration route behind an invitation code.** It was the dashboard's way in
while it called the gateway over HTTP; with the call inside the process a route
is only a door to guard, and its code a secret every host has to keep.
**Registration on the gateway.** A public form, a password and a rate limit on
the money path, and the gateway would need the account table this decision keeps
out of it.
