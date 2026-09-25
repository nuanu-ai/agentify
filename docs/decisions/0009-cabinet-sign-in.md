# 0009. Signing into the cabinet is a component's job, not ours

Date: 2026-08-28
Status: accepted (Dmitry, 2026-08-28: "просто сделай мне нормальную
авторизацию"; 2026-09-24, on a session of twelve hours: "нет, это баг. деньги
защищать нужно другим способом (cooldown например) нам нужно сделать удобно
для пользователя")

Rewritten, not annotated: the version of 2026-08-27 described a sign-in written
by hand, and its whole middle is the mechanism being removed. No merchant has
built on it; the history is in git.

## Context

The cabinet has to sign a person in, keep them signed in, confirm the address
they typed, let a lost password be recovered, and refuse a form posted from
somewhere else. All of it was ours, and three things ended that.

Self-service registration made the cabinet multi-tenant, which inverts the
original argument: a component's user and session model no longer has to be bent
around a cabinet with one merchant, it fits one with many. The hand-written
form-origin check had already cost a live outage — it built the origin it
expected out of a forwarded header, so an honest browser was told its form came
from somewhere else, exactly as the comment beside it had predicted. And the
expensive half was still ahead: confirmation and reset mean tokens, expiry,
single use, resend limits, and a form that must not become a way of asking which
addresses are registered.

One account, one deployment, no merchant depending on it: the cheapest moment
this will ever be.

## Decision

**1. Identity comes from Better Auth, in our own process on our own Postgres
through drizzle.** A library, not a service: nothing more to deploy, no second
database, nobody else's availability in front of the screen a merchant opens
when their selling has stopped. Verified before choosing rather than
remembered — it runs in a plain express app, its server API can be called from
our handlers, mail is a function we supply, and telemetry is off by default. We
switch telemetry off explicitly anyway: a default we depend on can change.

**2. Tenancy stays ours.** The merchant on the account, that merchant's key, the
gateway client built per request from it, the key screens, the gate above every
route. None of that is identity and no component would know what to do with it.
The gate denies by default, and what stands above it is listed here rather than
discovered by reading the routing: the sign-in and the sign-out, the page a
mailed link lands on, the stylesheet, the health probe, the callback a connected
shop posts its keys to, and the address that shop sends the merchant's browser
back to. The last of those is above the gate because a browser can come back
from the shop without a live session, and behind the gate a connection that
worked would end on a sign-in form and read as a failure; a browser that does
carry one is sent on into the cabinet. It is safe there because without a
session it reads nothing and answers every visitor the same page. That is the
test for anything else proposed for this list: without a session the route
reads nothing, and its answer is the same for a stranger as for the owner.

**3. The screens stay server-rendered forms.** Our handlers call the component's
server API and pass on the cookie it makes, so the cabinet keeps working without
JavaScript and nothing pulls in a client framework. One screen carries one
inline script (Dmitry, 2026-09-22): the page a merchant lands on after asking
for a link draws the resend with the wait in front of it counting down on the
button, the way the rest of the web does it. What a script may do here is take a
control away and give it back — the HTML is always the working page, never a
disabled one waiting to be enabled, because a browser that ran nothing must be
left with the button it would have had, and the door refuses the early press in
words either way.

**4. Mail is a function we supply; with no provider it writes to the log.** Resend
on a server, from a subdomain of its own so this product's reputation and the
company's Workspace mail are not one basket. Locally the whole flow walks with
no account, no domain and no network, and the suite stays offline. Nothing reads
mail: receiving is off, and the address a person sees says replies go nowhere.

**5. The message is the way in.** Rewritten by ADR-0026: there is no password
and no invitation, an address and a one-time link are the whole of signing in,
and the account is made when the link is consumed. The worry this paragraph
used to answer — a mail filter leaving somebody with an account they cannot
reach, recoverable only by us at a terminal — cannot arise when an undelivered
message makes no account at all: the person is still at the screen, and the
resend is on it.

**6. A session is a row, and one cookie carries it across the origin.** A
session can be ended one at a time, without touching the merchant's running
code, and it opens everything a person may see on the site (ADR-0026). Its
cookie is `HttpOnly`, `SameSite=Lax` and `Path=/`, and wherever the site is
served over https it is also `Secure` and named with the `__Host-` prefix; the
plain-http local origin gets neither, because the prefix requires `Secure`. A
cookie path is no boundary inside one origin, since a script on any page can
send a request to any path, so the origin is the boundary, as ADR-0005 §1 and
the edge configuration say, and `Path=/` is what makes the prefix available.
The prefix closes what a path-scoped cookie leaves open: a cookie carrying it
cannot name a `Domain`, so another host under the same registrable domain, as
`test.agentify.ad` is beside `agentify.ad`, can neither plant a session here
nor overwrite one. `Lax` lets a link to a report or to the cabinet, opened from
chat or from mail, arrive signed in. A cross-site POST carries no `Lax` cookie,
exactly as it carries no `Strict` one, so every form keeps its protection. That
holds only while nothing a page on another site can start changes a person's
data or selling: every such change is a POST, or another method no link can
send. The check that a form came from this host stays, because
`SameSite` is judged per registrable domain and that other host is the same
site.

The session lasts thirty days from the last visit, so a person who keeps coming
back does not meet the sign-in form again; its end is moved at most once a day,
so a click is not a write, and the renewed cookie reaches the browser on the
answer that moved it. A short session is not what protects
the money; the wait on a wallet change is (ADR-0019).

## Consequences

Out: our password derivation, our session table and sweep, our sign-in and
password handlers. Tests that described those mechanisms go with them; tests
that describe what a merchant experiences are rewritten against the new
mechanism, because they are what says the swap changed nothing anybody can see.

A merchant who can read their mail is never locked out (ADR-0026): signing in
and recovering access are one act, and there is no unconfirmed account to
recover. And we become a sender — a domain whose
reputation can be spent, a bounce stream nobody reads yet, a provider whose
outage merchants can feel — answered by sending only transactional mail, by
limiting how often one can be asked for again, and by not waiting for delivery.

## Alternatives rejected

**Keep writing it by hand.** Defensible for one merchant whose account we made
ourselves, and it stopped being so the morning registration existed — having
already refused an honest merchant's sign-in on the live site.

**A hosted identity provider.** Removes the most code, and puts a vendor's
availability in front of the worst possible screen with merchant identities in
their database rather than ours.

**A separate auth service — Kratos, Keycloak, Zitadel.** Each is a second
deployment, database and backup, for a cabinet with one merchant. Worth
revisiting the day there are identities outside the cabinet to federate.

**Letting the browser call the component directly.** The usual way it is used,
and it would make signing in need JavaScript.

**A short session that is never extended.** It sends a person back to the
mailbox every time they return and protects nothing the wallet wait does not;
Dmitry named it a defect.
