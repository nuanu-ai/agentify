# 0026. One identity: email links, Google and one session for the site

Date: 2026-09-24
Status: accepted (the product owner, 2026-08-28 to 2026-09-25; Google sign-in,
2026-10-15); merges what were ADR-0009 and ADR-0024

## Context

One origin (ADR-0005) serves scanner reports, the seller dashboard and `/admin`.
An address identifies its person; each sign-in must prove current ownership.

## Decision

**1. Email links and Google authenticate the same person.** An address typed at
scanner or dashboard receives a hashed, single-use link lasting an hour. Only
its page's same-origin button spends it and creates any missing account; a mail
preview cannot. Spent, expired and unknown links are refused alike, without
revealing whether an address has an account or report. The destination lives
with the token. A destinationless link, or a dead one while signed in, leads to
the latest report for a person with reports and no merchant, else the dashboard.
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
address and offer sign-out; shared caches keep no answer carrying an address.
Sign-out ends this browser's session, and settings can end all its other ones.
Every dashboard form behind the gate and scanner account form names the address
it was drawn for; another address or no address is refused without action.

**4. Only an explicit dashboard request creates a merchant.** A signed-in person
without one sees one control. Only its same-origin POST asks the gateway inside
the shared process (`docs/research/35-one-process.md`) to create one (ADR-0014).

**5. Live publication guards the shared catalogue.** `readinessOf` in core is
used by every publication and selling path: a seller name everywhere, a payout
wallet for settled payments (ADR-0020), and administrative approval on live.
The commission is the price; no subscription replaces this approval.
Publishing tells an integrator what is missing.

**6. Operators use the same sign-in.** `/admin` needs the account flag set only
by `pnpm account operator`, read on every session request. The header shows its
link to operators. Everybody else, including while identity is unavailable,
gets the site's 404; the edge neither marks nor guards this read-only path.
The page links to `/dashboard/admin/live-sales`, which checks the same flag
on each request and admits one existing merchant after explicit confirmation.
Its forms also pass the dashboard's origin and account checks; the operator
needs no merchant of their own. Approval is live-only and idempotent, and does
not bypass another selling guard or assert a payment outcome. No staff queue
is promised by this permission.

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
