# 0026. One identity: email links, Google and one session for the site

Date: 2026-09-24
Status: accepted (the product owner, 2026-08-28 to 2026-09-25; Google sign-in,
2026-10-15; signing out everywhere, revised 2026-10-23; administration moves
from the terminal to the operator's workspace, 2026-10-23; the admission as the
one lever over a merchant, with a note the merchant reads, 2026-10-24; a sign-in
on the dashboard's page asks for the merchant, 2026-10-26); merges what were
ADR-0009 and ADR-0024

## Context

One origin (ADR-0005) serves scanner reports, the seller dashboard and `/admin`.
An address identifies its person; each sign-in must prove current ownership.

## Decision

**1. Email links and Google authenticate the same person.** An address typed at
scanner or dashboard receives a hashed, single-use link lasting an hour. Only
its page's same-origin button spends it and creates any missing account; a mail
preview cannot. Spent, expired and unknown links are refused alike, without
revealing whether an address has an account or report. The destination lives
with the token. A link asked for from one of the scanner's doors, or a dead one
while signed in, leads to the latest report for a person with reports and no
merchant, else the dashboard.
The token's claim may also keep the ad click the sign-in page was opened with
(ADR-0039).

The dashboard also offers Google when configured. Google must verify the
current address and control its mailbox: `gmail.com`, `googlemail.com`, or a
Workspace account with a hosted-domain claim. Other addresses use an email
link. The Google issuer and subject bind to the account with that exact address;
a linked subject with a different current address is refused. Addresses are
trimmed and lowercased, never merged by Gmail dots, plus suffixes or domain
aliases. Google supplies no seller name and carries no scanner report request;
its single-use state may keep the ad click the sign-in page was opened with
(ADR-0039).

**2. The dashboard holds one identity and session for the whole site.** Better
Auth runs in its process on our PostgreSQL with telemetry off, through our
handlers and its server API; its HTTP routes stay unmounted. A session is a
revocable row, lasting thirty days from the last visit and renewed at most
daily. Its cookie is `HttpOnly`, `SameSite=Lax`, `Path=/`, and on HTTPS `Secure`
with `__Host-`, so a sibling host cannot plant it. Every change uses POST and a
post with another host's `Origin` is refused. Google's callback is the GET
exception: Better Auth checks single-use browser-bound state and PKCE before
our email rules admit a session. Identity changes commit before its cookie is
issued. Google access, refresh and ID tokens are never stored in rows or cookies.

The scanner signs nobody in and sees no token. A secret internal route with no
public port asks the dashboard to send links, read sessions and delete people
without merchants; only the scanner's renewal header extends a session. Failure
to read identity is said as uncertainty, never as signed out. The two share a
database, not tables. A report opens for the session address's linked lead. A
full-report request finishes on the first visit of the session its link opens;
a signed-in ask names its address and finishes at once, never another request.
Deleting an address closes its reports and removes its lead and, if it owns no
merchant, its account. Sign-in and deletion serialize on that same address.

**3. Headers and sign-out belong to the whole site.** Headers name the signed-in
address and offer sign-out from the account menu; shared caches keep no
answer carrying an address. Sign-out ends this browser's session, and
settings can end every session of the account, this browser's included: a
session copied from this browser carries the same token, so keeping this one
would keep the copy.
Every dashboard form behind the gate and scanner account form names the address
it was drawn for; another address or no address is refused without action.

**4. Only an explicit dashboard request creates a merchant.** The scanner signs
people in too, and somebody who signs in only to read a report does not become
a merchant. A sign-in asked for on the dashboard's sign-in page is itself the
request: the page records it with the link's token or the Google state, and
that sign-in, finished in any browser, creates the merchant of a person who has
none. The scanner's doors open the same page marked as a sign-in to read
reports, which creates nothing, and nothing the end of a sign-in carries
changes what was recorded. A person signed in any other way without a merchant
sees one control, and only its same-origin POST is the request. Either asks the
gateway inside the shared process (`docs/research/35-one-process.md`) to create
one (ADR-0014); a failure leaves the person signed in, on that control.

**5. Live publication guards the shared catalogue.** `readinessOf` in core is
used by every publication and selling path: a seller name everywhere, a payout
wallet for settled payments (ADR-0020), and administrative approval on live.
The commission is the price; no subscription replaces this approval.
Publishing tells an integrator what is missing.

**6. Operators use the same sign-in.** `/admin` needs the account flag, read on
every session request, and so does the operator's workspace under
`/dashboard/admin`, whose layout checks it before any of its pages reads or
acts. The header shows its link to operators. On `/admin` everybody else,
including while identity is unavailable, gets the site's 404. In the workspace
a person the flag does not confirm gets the 404, a signed-out visitor meets the
sign-in, and while identity cannot answer nothing of it is drawn: the gate's
error page or the 404. The edge neither marks nor guards these paths. The
workspace admits one existing merchant to live sales after explicit
confirmation; its forms also pass the dashboard's origin and account checks,
and the operator needs no merchant of their own. Approval is live-only,
granting and withdrawing it are both idempotent, and a merchant whose approval
is withdrawn stands as one not approved, a pause rather than a cancellation;
their dashboard says since when their live sales are stopped and shows the
operator's note. The approval is the one lever the operator holds over a
merchant: the workspace never sets or takes away a merchant's seller name
(the product owner, 2026-10-24).
Neither bypasses another selling guard or asserts a payment outcome; no staff
queue is promised by this permission. The product owner decided on 2026-10-23
that every administrative action at the terminal, the operator flag's included,
moves into the operator's workspace (`docs/research/85-operator-admin.md`).
None is left at the terminal but the statement `deploy/README.md` documents for
a channel that lost every operator, which writes its journal row naming the
terminal. In
the workspace every administrative action needs a session signed in within the
last fifteen minutes, by the sign-in moment a renewed session keeps; an older
session is asked to sign in again, by link or Google, which returns that browser
to the page it pressed on, where the operator presses again; nothing is queued
for the sign-in to carry out, and the step's link is counted apart from the
public form's. Each intervention carries the operator's reason, and every action
and refused attempt is journaled (ADR-0045). Granting or removing the flag waits
until a mail to every operator of the channel and to the account changed has
been handed over, and the last operator's flag cannot be removed nor its account
forgotten. A channel takes its first operator from its configuration, once, at
the configured address's next sign-in while no account holds the flag, and never
reads that configuration again.

**7. One gate protects dashboard pages.** Its exceptions are sign-in, sign-out,
the link landing page, Google start and callback, styles and built scripts,
the route table, health probes and a shop's key callback and return. An exception
reads nothing private and answers all alike without a session, or validates its
own single-use authentication proof before accessing an identity.

## Consequences

Either eligible sign-in opens the same identity; email links remain available
when Google cannot be used. Ending sessions does not revoke Google access: a
compromised Google account must be recovered with Google. Google is an alternative,
not a second factor. An open session moves no money because a wallet replacement
waits (ADR-0019). A dashboard outage stops sign-in and, in the shared process,
sales. A second factor is a later stage.

Rejected: hand-written identity infrastructure; a hosted or separate identity
service; a second identity store for deletion to miss; and mailbox-recovered
passwords. Each adds another security mechanism or operating dependency.
