# How sign-in, sessions and admission to live sales work

2026-10-31. Design note: the mechanics behind the decision on one identity
([ADR-0026](../decisions/0026-one-way-in.md)) and behind the journal of
administrative actions
([ADR-0045](../decisions/0045-every-administrative-action-leaves-a-journal-row.md)).
The decisions say what holds and why; this note says how the code holds it,
and is rewritten whenever the code changes. The operator's workspace as a
whole is designed in [research note 85](85-operator-admin.md).

One origin serves three things: the scanner's reports, the seller dashboard
and the scanner's own admin page at `/admin`. The dashboard keeps the identity
for all three. A *person* is an address that has signed in; an *account* is
that person's row in the dashboard's database; a *merchant* is the seller an
account may name, with its cards and orders in the gateway.

## Email links

An address typed at the scanner or the dashboard receives a link whose token
is stored hashed, is spent once and lasts an hour. Only the button on the
link's own page spends it, by a post from the same origin, and that press
creates the account if there is none; a mail client that opens the link to
preview it spends nothing. A spent, an expired and an unknown link are refused
in the same words, so nobody learns from a refusal whether an address has an
account or a report. The place the person was going is stored with the token.
A link asked for from one of the scanner's doors, or a dead link opened while
signed in, leads to the latest report of a person who has reports and no
merchant, and otherwise to the dashboard. The token's claim may also keep the
ad click the sign-in page was opened with, for the report to the ad tracker
([ADR-0039](../decisions/0039-what-an-ad-brought-is-reported-to-its-tracker.md)).

## Google

The dashboard offers Google when the channel is configured for it. Google
counts only where it vouches for the current address and controls its
mailbox: `gmail.com`, `googlemail.com`, or a Workspace account whose token
carries a hosted-domain claim. Every other address signs in by link. The
Google issuer and subject are bound to the account with that exact address,
and a subject already bound to an account whose address has since changed is
refused. Google supplies no seller name and
carries no request for a scanner report; its single-use state may keep the ad
click, as a link's token does.

## Sessions and their cookie

Better Auth runs inside the dashboard's process on our PostgreSQL with its
telemetry off. It is reached through our own handlers and its server API; its
HTTP routes are never mounted. A session is a row that can be revoked. It
lasts thirty days from the last visit and is renewed at most once a day. Its
cookie is `HttpOnly`, `SameSite=Lax` and `Path=/`, and on HTTPS it is also
`Secure` and named with the `__Host-` prefix, so a sibling host cannot plant
one. Every change is a POST, and a post whose `Origin` names another host is
refused. Google's callback is the one GET that changes anything: Better Auth
checks its single-use, browser-bound state and its PKCE verifier before our
own rules about addresses admit a session. A change to an identity commits
before its cookie is issued. Google's access, refresh and ID tokens are never
stored, in a row or in a cookie.

## The scanner

The scanner signs nobody in and never sees a token. The internal route it
reaches the dashboard over sends links, reads sessions and deletes people who
have no merchant; only the scanner's
renewal header extends a session. When the scanner cannot read an identity it
says it does not know, and never draws the visitor as signed out. The two
share a database but not tables. A report opens for the linked lead of the
session's address. A request for the full report finishes on the first visit
of the session its link opens; a signed-in person asking names their address
and finishes at once, without a second request. Deleting an address closes
its reports and removes its lead, and removes its account when the account
names no merchant. A sign-in and a deletion of one address are serialized.

## Headers, sign-out and forms

The header names the signed-in address and offers sign-out from the account
menu. Signing out
ends this browser's session. Settings can end every session of the account,
this browser's among them, because a session copied from this browser carries
the same token and keeping this one would keep the copy. Every dashboard form
behind the gate, and the scanner's account form, names the address it was
drawn for; a post naming another address, or none, is refused and does
nothing.

## Creating a merchant

A sign-in asked for on the dashboard's sign-in page is itself the request for
a merchant. The page records it with the link's token or Google's state, and
that sign-in, finished in any browser, creates the merchant of a person who
has none. The scanner's doors, the site's sign-out and the page of a dead link
that made no merchant open the same page marked as a sign-in to read reports,
which creates nothing, and nothing carried by the end of a sign-in changes
what was recorded. A person signed in any other way without a merchant sees
one control, and only its same-origin POST is the request. Either way the
dashboard asks the gateway inside the shared process
([research note 35](35-one-process.md)) to create the merchant; a failure
leaves the person signed in, in front of that control.

## The gate

One gate protects every dashboard page. Its exceptions are sign-in, sign-out,
the link's landing page, Google's start and callback, styles and built
scripts, the route table, health probes, and a shop's key callback and return.
An exception reads nothing private and answers everybody alike without a
session, or checks its own single-use proof before it reaches an identity.

## Operators

The operator flag on an account opens `/admin` and the operator's workspace
under `/dashboard/admin`. It is read on every request, and the workspace's
layout checks it before any of its pages reads or acts. On `/admin` everybody
else, including everybody while identity cannot be read, gets the site's 404.
In the workspace a person the flag does not confirm gets the 404, a signed-out
visitor meets the sign-in, and while identity cannot answer nothing of the
workspace is drawn. The site's edge neither marks nor guards these paths. The
workspace's forms pass the dashboard's origin and address checks as well, and
an operator needs no merchant of their own.

The fifteen minutes of a fresh sign-in are measured from the sign-in moment
that a renewed session keeps. An older session is asked to sign in again, by
link or by Google, and that browser returns to the page it pressed on, where
the operator presses again. Nothing is queued for the sign-in to carry out,
and the link this step sends is counted apart from the public form's. A
channel that has lost every operator is recovered on its host by the statement
`deploy/README.md` documents, which writes its journal row naming the
terminal.

## Admission to live sales

Admission is live-only. Granting it and withdrawing it are both idempotent: a
second press finds the change made and changes nothing. A merchant whose
admission is withdrawn stands as one not admitted, a pause and not a
cancellation; their dashboard says since when their live sales are stopped and
shows the operator's note.

A merchant asks for live sales with a seller name and dated evidence: when
their code last connected, or what the latest check of their shop found ready.
No wallet is asked for. The gateway keeps the request and its evidence until
it is answered, and asking again while a request waits keeps the first date
and evidence. The operator's waiting list holds the pending requests, oldest
first. A request is answered by an admission, which may also come without any
request, seller name or wallet, or by a decline with a mandatory note. The
merchant reads the whole note in the dashboard and by email, and may address
it and ask again.

A decline names the exact request it answers, and its journal row is the note
the merchant reads. The decline, its journal row and the intent to mail the
merchant commit in one transaction. A repeated press, or a press on a page
drawn before the merchant asked again, finds that request no longer pending
and declines nothing. A withdrawal's reason is likewise the note its merchant
reads: the merchant's dashboard reads the newest withdrawal row of its own
merchant while that withdrawal stands, and no other row of the journal, and
the form that asks for the reason says so and asks that it name no buyer.

The journal records every administrative action and every refused attempt made
after the operator flag was checked. A request the flag refuses writes
nothing, and nor does one that names its subject by something that cannot be
an identifier, since the journal holds identifiers only. A refused attempt,
which changes nothing, writes its row in a transaction of its own; when that
write fails, the attempt is refused all the same and the failure is logged.
