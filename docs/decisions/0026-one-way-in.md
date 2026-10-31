# 0026. One identity: email links, Google and one session for the site

Date: 2026-09-24
Status: accepted (the product owner, 2026-08-28 to 2026-09-25; Google sign-in,
2026-10-15; signing out everywhere, revised 2026-10-23; administration moves
from the terminal to the operator's workspace, 2026-10-23; the admission as the
one lever over a merchant, with a note the merchant reads, 2026-10-24; a sign-in
on the dashboard's page asks for the merchant, 2026-10-26); merges what were
ADR-0009 and ADR-0024

## Context

One origin (ADR-0005) serves scanner reports, the seller dashboard and `/admin`;
an address identifies its person, and each sign-in must prove current
ownership. How the code keeps each rule below is in [research note 95](../research/95-identity-and-admission.md).

## Decision

**1. Email links and Google authenticate the same person.** A link is hashed,
single-use, short-lived and spent only by a same-origin press on its page, and
that press creates the account of an address that has none; Google counts only
for an address whose mailbox it controls. No refusal reveals whether an
address has an account. Addresses are trimmed and lowercased and never merged
by Gmail's dots, plus suffixes or domain aliases: deciding that two addresses
are one person cannot be taken back.

**2. The dashboard holds one identity and session for the whole site.** Better
Auth runs inside it on our PostgreSQL with its HTTP routes unmounted; a session
is a revocable row behind one cookie that reaches every surface of the origin
and that no sibling host can plant, every change is a same-origin POST, and no
Google token is kept. The scanner signs nobody in and sees no token: it reaches
the dashboard only over an internal route with a secret and no public port,
and identity it cannot read is said as unknown, never as signed out.

**3. Headers and sign-out belong to the whole site.** Shared caches keep no
answer that carries an address. Settings can end every session, this
browser's included; a form names the address it was drawn for.

**4. Only an explicit dashboard request creates a merchant**, through the
gateway in the shared process (ADR-0014); reading a report never does. A
sign-in asked for on the dashboard's sign-in page is itself the request (the
product owner, 2026-10-26). A person signed in any other way without a
merchant sees one control, and only its same-origin POST is the request; a
failure leaves them signed in, in front of that control, to press again.

**5. Live publication guards the shared catalogue.** `readinessOf` in core is
used by every publication and selling path: a seller name everywhere, a payout
wallet for settled payments (ADR-0020), and administrative approval on live.
The commission is the price; no subscription replaces this approval.

**6. Operators use the same sign-in, and a person admits a merchant to live
sales.** The operator flag opens `/admin` and the workspace; everybody else
gets the site's 404. A merchant asks with a seller name and dated evidence of
their connection, and no wallet; an operator admits them, or declines with a
mandatory note the merchant reads before asking again, and may admit without
a request. The admission is the one lever the operator holds over a merchant,
and a withdrawn admission is a pause with a note the merchant reads (the
product owner, 2026-10-24).
The workspace never sets or takes away a seller name. Neither admission nor
decline bypasses another selling guard or asserts a payment outcome (the
product owner, 2026-10-30). Admission goes through a person, the reply time
the merchant is told is an expectation and not a promise, and an ordinary sale
needs no staff. The product owner decided on 2026-10-23 that every
administrative action at the terminal, the operator flag's included, moves
into the workspace (`docs/research/85-operator-admin.md`); each needs a
sign-in within the last fifteen minutes and a reason, and is journaled
(ADR-0045). Granting or removing the operator flag waits until a mail to every
operator of the channel and to the account changed has been handed over. The
last operator's flag cannot be removed nor their account forgotten. A channel
takes its first operator from its configuration once, at that address's next
sign-in while no account holds the flag, and never reads it again.

**7. One gate protects dashboard pages;** its few exceptions read nothing
private or check their own single-use proof first.

## Consequences

Either sign-in opens the same identity; Google is an alternative, not a second
factor, and ending sessions does not revoke Google access. An open session
moves no money because a wallet replacement waits (ADR-0019). A dashboard
outage stops sign-in and, in the shared process, sales.

Rejected: hand-written identity infrastructure; a hosted or separate identity
service; a second identity store for deletion to miss; and mailbox-recovered
passwords. Each adds another security mechanism or operating dependency.
