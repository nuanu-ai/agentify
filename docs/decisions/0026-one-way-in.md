# 0026. One way in: an address, a one-time link and one session for the site

Date: 2026-09-24
Status: accepted (the product owner, 2026-08-28 to 2026-09-25); merges what were
ADR-0009 and ADR-0024

## Context

One origin (ADR-0005 §1) serves the scanner's reports, the seller dashboard and
the operator's `/admin`. Whoever reads an address's mail is its person.

## Decision

**1. One means of authentication.** No password or invitation code is typed. An
address typed at the scanner or dashboard is mailed a link to the dashboard page
naming it, and only a same-origin press of its button spends the token, which a
mail preview cannot; the press writes any missing account and opens the session.
The token, hashed and single-use, lives an hour; a spent, expired or unknown one
is refused alike, and no answer says whether an address has an account or a
report. Where a link leads is kept with its token, not in the link; one with no
destination, or a dead one while signed in, goes to the person's start: their
latest report if they have one and no merchant, else the dashboard.

**2. One identity and one session, held by the dashboard.** Identity is Better
Auth, a library in the dashboard's process on our PostgreSQL with telemetry off,
used only through its server API from our handlers. A session is a row, so it
can be ended alone, and it serves the whole site. Its cookie is `HttpOnly`,
`SameSite=Lax` and `Path=/`, since inside one origin a path is no boundary, and
over https `Secure` with the `__Host-` prefix, so another host under the domain,
such as `test.agentify.ad`, cannot plant or replace it. `Lax` lets a link from
mail arrive signed in, so every change is a POST, and as `SameSite` spans the
registrable domain, a post whose `Origin` names another host is refused. A
session lasts thirty days from the last visit, renewed at most daily.

The scanner signs nobody in and never sees a token. Over an internal route with
no public port, behind a secret only the two hold, it asks the dashboard to send
a link, to say whose session a cookie is and, for a deletion, to remove a person
who owns no merchant; only its header asks to renew a session. A page that
cannot reach the dashboard says it cannot tell who is visiting: not knowing who
somebody is must not look like knowing they are nobody. The two share a database
(ADR-0003 §2) but not tables. A report opens for a session whose address's lead
is linked to its scan. A full-report request finishes at the first visit of the
session its link opens; a signed-in ask names the address it files under and
finishes at once, never somebody else's request. Deleting an address closes its
reports at once and removes its lead and, if it owns no merchant, its account.

**3. The header and signing out.** Scanner and dashboard headers show a
signed-in address and a sign-out, and no shared cache keeps an answer carrying
an address. Signing out ends this browser's session, and settings can end every
other one. People mostly sign out to return as another address, so every form
behind the dashboard's gate and every scanner account form carries the address
its page was drawn for, and one naming another or none is refused unacted.

**4. The merchant is made on the dashboard's explicit request.** A signed-in
person without one is offered one control, and only its same-origin POST asks
the gateway for the merchant and the key the dashboard calls with; under `Lax` a
link from another site arrives signed in, so opening one makes nothing. That
press is the only way to a merchant, as the link is to an account (ADR-0014).

**5. The door to the shared catalogue is live publication**, not an invitation,
which stops nobody. One rule, `readinessOf` in `packages/core`, asked by every
path that publishes, sells or says whether a merchant can, wants a seller name
everywhere, a payout wallet where payments settle (ADR-0020) and, on live, the
operator's approval, until the day the operator cannot keep up and it becomes a
paid subscription. Integrators learn what is missing only by publishing.

**6. The operator enters through the same door.** `/admin` opens for a session
whose account carries the operator flag, set only by `pnpm account operator`,
never by a configured list, and read with the session on every request, so a
change holds from the next page; the header shows an operator the way in.
Anybody else, and everybody while the dashboard cannot answer, gets the site's
404 page, and nothing at the edge guards or marks the path. It is read-only.

**7. The dashboard's gate.** One middleware turns away a visitor without a
session at every dashboard address but sign-in, sign-out, a link's landing page,
the stylesheet, the health probe and a shop's key callback and return; a route
joins those only if, without a session, it reads nothing and answers all alike.

## Consequences

The mailbox is the whole key, to sign in and to recover access, and delivery is
the way in's single point of failure. A session left open moves no money, since
a payout wallet change waits (ADR-0019), so a short session would protect
nothing. A dashboard that is down stops sign-in and, sharing the gateway's
process (ADR-0030), sales. A second factor outside the mailbox is a later stage.

Rejected: identity written by hand, as tokens, expiry and resend limits are the
hard half; a hosted or separate identity service, one more system to be up
before a merchant reaches their dashboard; a second identity store, another
place for a deletion to miss; and a password, which the mailbox recovers.
