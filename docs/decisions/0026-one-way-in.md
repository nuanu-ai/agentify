# 0026. One way in: an address and a one-time link, on both doors

Date: 2026-09-17
Status: accepted (Dmitry, 2026-09-17: "средство аутентификации у нас —
ссылка из письма"; the scanner's confirmation is trusted at the cabinet's
door, his word of 2026-09-16)

## Context

Two surfaces, two ways in. The scanner signs nobody in: an address and a
one-time link open a report, and a thirty-day cookie remembers that. The
cabinet asks for an address, a password and an invitation code typed by hand;
confirming the address is optional and buys only recovery, so an unconfirmed
account with a lost password is recovered by us at a terminal. Nothing links
the two. A person who has just confirmed an address at the scanner types it
again at the cabinet, invents a password nobody asked for, pastes a code, and
is asked to confirm the same address a second time — because the cabinet does
not trust a confirmation the same operator made a minute earlier, on the same
host, with the same pinned component and the same sender (ADR-0009, ADR-0024).

ADR-0014 §3 named the day the invitation retires: when a confirmed address
replaces it. Dmitry settled the shape: the product has one means of
authentication, and it is the link.

## Decision

**1. One means of authentication on both doors.** Whoever can read mail at an
address is the person of that address. There is no password and no invitation
code. Typing an address at either door sends one message with one button;
opening it lands on a page of ours with one control, and only that same-origin
submission consumes the token, so a mail preview cannot spend it. The token is
hashed at rest, single-use and short-lived — the construction the scanner has
already. Signing in and recovering access are the same act, and no case is
left that needs a person at a terminal.

**2. One identity, held by the cabinet; a link is still written for one
door.** The person of an address is one row, in the cabinet's component and
the cabinet's database, and the scanner has no identity tables of its own.
When the scanner needs a link sent or a token verified it asks the cabinet
over the internal route of paragraph 3, and what it keeps is report access
alone — a capability bound to a lead, not a person. A person may own a report
and no merchant: the merchant and its key are attached the first time that
person's link is consumed at the cabinet's door (paragraph 4). The scanner's
link opens a report and the cabinet's opens the cabinet; no session is shared,
each application keeps its own, and no cookie widens past the cabinet's path
(ADR-0009 §6). ADR-0024's separation stands for scans, reports and leads and
is edited for identity in this same change. On one origin (ADR-0005 §1) every
link the scanner shows is a same-origin navigation.

**3. The cabinet trusts the scanner's confirmation at the moment it happens.**
When the scanner has just confirmed an address, it asks the cabinet — over the
internal route it uses for its own links, reachable only on the compose network
and authenticated by a secret the two processes share — to issue a link for
that address, and shows it as the control that opens the cabinet instead of
mailing it. It is the cabinet's ordinary link: the same token, the same
landing page, the same single use and lifetime. Pressed later, from a report
cookie days old, the same control has the cabinet mail the link instead: the
cookie is a right to read a report, not proof that anybody is at the mailbox.
The assertion crossing the boundary is "this address was confirmed now, by
us", it crosses through one route that answers only the scanner's process,
and nothing on the public origin can ask for a link to be returned rather
than sent.

**4. The merchant is made when the link is consumed at the cabinet's door.**
A link consumed there for a person who owns no merchant makes the merchant,
the key its cabinet calls with and, if there is none yet, the person's row, in
one act and in ADR-0014's order — gateway first — with the address confirmed by
construction. A person who owns a merchant signs into it. A message that never
arrived leaves nothing behind, and registering is the same screen as signing
in.

**5. The door to the shared catalogue moves from registration to live
publication.** Anyone who reads their mail holds a cabinet, integrates against
the SDK and sells in the test contour. Live publication is refused until the
merchant has a seller name and a payout wallet, as today, and until the
operator has switched that merchant on, once. The named trigger for the switch
becoming a paid subscription is the day the operator cannot keep up.

## Consequences

Out: the password and everything that existed for it — its derivation, the
change, forgot and new-password screens, the reset message, the unconfirmed
state and its banner, and the sentence that sends a merchant to whoever gave
them the address of this site. Out: the invitation typed by a person and the
register screen. The gateway's registration route keeps its code as a value in
the cabinet's configuration: it guards the wire between two processes of ours
and is no longer a door for people. The account command keeps making an
account for a merchant that already exists — the seeded one — and stops
printing a password. Existing accounts lose their passwords and keep their
merchants and data; their sessions end at the switch, and an address that was
never confirmed is confirmed by its first sign-in through a link, not declared
confirmed by the migration.

Out, one step later: the scanner's own instance of the component and its
identity tables, retired once the route carries the scanner's links — later
rather than at once, so that at no point does the scanner depend on a cabinet
that still holds passwords.

In: the magic-link plugin in the cabinet, inside the Better Auth already
pinned in the tree, so the dependency tree gains nothing; one internal route
on the cabinet with three verbs — send a link for the scanner's door, verify
its token, issue a link for the cabinet's door; one secret in two deployments;
a control in the report and the same control on the Agentic Shop page, in
place of the application form. The token is consumed in the cabinet and the
lead is written in the scanner, which is not one transaction: verify first,
then write, idempotent on the token, so a token verified and never turned
into a lead is finished by the same click or expires unharmed. A deletion
request at the scanner revokes report access, removes the lead and, for a
person who owns no merchant, the person's row; a person who owns a merchant
is removed by the merchant's own rules, which are not built (ADR-0014).

What it costs, said on the door: the mailbox is the whole key. A person who
loses the mailbox loses the cabinet, and no second route is pretended here.
Delivery becomes the single point of failure of the way in — measured, with
the resend on the same screen. Somebody reading a merchant's mail is that
merchant, and a shared mailbox is a shared cabinet. This decision sets the
floor and names the ceiling as its second stage, agreed in principle by
Dmitry on 2026-09-17 and detailed later: a second factor that does not live
in the mailbox, optional for everybody and required before live publication,
and a step above the session on the actions that move money, beginning with
the payout wallet, whose change writes to the address and can be undone from
the message. Until that stage lands, none of it is assumed to exist, and the
work is tracked as such. One identity in one process is one process
whose absence stops every sign-in: when the cabinet is down nobody gets a link
at either door, and reports already opened keep opening. ADR-0009 §5 and its
consequences, ADR-0014 §1, §3 and its consequences, ADR-0024's identity
paragraphs and ADR-0005 §1 and §5 are edited in this same change.

Rejected: **login and password mailed to the person** — a secret in plain text
in a mailbox, in mail logs and in forwarded threads, chosen by nobody, doing
what the link already does. **One session for both applications** — buys the
client nothing they can see, and a cookie wide enough to serve both rides on
the money path. **Two identity stores kept** — every feature that has to know
a person is then written twice, and a privacy deletion has two places to miss.
**A second message at the transition** — proves the same address the same way
a minute later; the boundary is held by minting only at confirmation. **The
password kept as a second factor** — a factor recovered through the same
mailbox is not a second one; passkeys are the honest version and wait for the
first merchant who asks. **Trusting the report cookie** — a thirty-day cookie
on a shared laptop would open a cabinet in somebody else's name. **The
invitation kept as a hidden door** — held by the cabinet for everybody it
stops nobody; the door belongs where a stranger's words reach a buyer, which
is publication.
