# 0026. One way in: an address, a one-time link and one session for the site

Date: 2026-09-24
Status: accepted (Dmitry, 2026-09-17: "средство аутентификации у нас — ссылка
из письма"; 2026-09-24: "я думал что вот ссылка в письме один раз авторизует
тебя в продукте и ты можешь и отчеты смотреть и в кабинет ходить, а админка -
это некий привелигированный признак")

## Context

Agentify is one origin (ADR-0005 §1) on which a person reads the reports the
scanner writes about their site and sells from the cabinet, and on which whoever
runs the deployment reads the operator's dashboard at `/admin`. Whoever can read
mail at an address is the person of that address, and a link in a message is how
they show it. What had to be settled is how far one link reaches, and Dmitry's
answer is all of it: a person signs in once and is not asked again, and the
dashboard is a privilege an account carries rather than a door with a password
of its own.

## Decision

**1. One means of authentication and one kind of message.** There is no password
and no invitation code. An address typed in the scanner's full-report form or in
the one field of the sign-in page brings the same message with one button. Where
it leads, the full report of a named scan or a named cabinet screen, is recorded
with the token when the link is asked for, and nothing in the link is ever read
as a destination. Every link lands on the cabinet's page with one control, and
only that same-origin submission consumes the token, so a mail preview cannot
spend it; the cabinet then opens the session, sets the cookie and sends the
browser to the recorded destination. The token is hashed at rest, single-use and
short-lived. A used, expired or unknown link is refused the same way, and no
answer says whether the address has an account or a report. A link with no
destination of its own starts a person who owns a merchant in the cabinet, a
person who owns reports and no merchant at their latest report, never at a
screen offering to make a merchant, and anybody else in the cabinet; that is the
person's start. A used, expired or unknown link opened in a browser with a live
session goes to the start of that session's person instead of an empty form,
which reveals nothing about the link's address, because the session's own
address decides it. Signing in and recovering access are one act. Against a
sign-in link for somebody else's address sent to a victim, the page with the one
control names the address being signed in, the signed-in full-report ask names
the address the report will be filed under, and the header always shows it.

**2. One identity and one session, held by the cabinet.** The person of an
address is one row in the cabinet's Better Auth, and the session a link opens
serves the whole site, reports, the cabinet and, for an operator, the dashboard,
with the cookie and lifetime of ADR-0009 §6. The scanner never handles a token
and mints no session. Over the internal route, reachable only on the compose
network and authenticated by a secret the two processes share, it asks the
cabinet to send a link for this address with this destination, to say whose
session this cookie is, and, for a privacy deletion, to remove this person if
they own no merchant. When the second answer renews the session, the scanner
passes on the renewed cookie that answer carries, so a visit to a report counts
toward the thirty days. A public scanner page that cannot reach the cabinet says
it cannot tell who is visiting right now, because not knowing who somebody is
must not look like knowing they are nobody.

A report opens for a session whose address owns it, meaning the lead with that
address is linked to the scan. A request made in the full-report form waits for
its own link: the cabinet records, with the session that link opens, which
request the link was asked for, the answer to whose session a cookie is names
that request, and the scanner finishes it at the session's first visit,
wherever the navigation began. A signed-in person's own ask, a same-origin POST
carrying their own form choices, makes and finishes their request at once with
no message. It never finishes a waiting request somebody else made with that
person's address, which is left to expire, because a waiting request carries
what its form said, a marketing choice included. The lead holds what the
scanner learned about a person, their role, volume and unsubscription, and is
not a way in.

**3. The header and signing out.** When a person is signed in, the header of the
scanner's and the cabinet's pages carries their address and a sign-out control;
`/docs` keeps only its plain link to the cabinet (Dmitry, 2026-09-24). A
response carrying a person's address is never stored by a shared cache, however
the code draws the header. The sign-out is a same-origin POST that ends this
session's row, clears the cookie and opens the sign-in page with an empty field,
since people mostly sign out to come back as another address. It signs this
browser out of everything and leaves other devices alone.

**4. The merchant is made on the cabinet's explicit request.** A person may own
reports and no merchant. The cabinet offers a signed-in person without one a
screen with one control, and only that same-origin POST asks the gateway for the
merchant and the key the cabinet calls with. Opening a link never makes one,
"Open your cabinet" on a report included, because under `Lax` a link from
another site arrives signed in. A gateway that does not answer leaves the person
signed in to press again, and a cabinet that fails after the gateway answered
leaves a merchant nobody names, litter as ADR-0014 §1 says.

**5. The door to the shared catalogue is live publication.** Anyone who reads
their mail holds a cabinet, integrates against the SDK and sells on the test
channel. Live publication is refused until the merchant has a seller name and a
payout wallet and the operator has switched that merchant on, once, with
`pnpm approve`. The named trigger for the switch becoming a paid subscription is
the day the operator cannot keep up.

**6. The operator enters through the same door.** Dmitry's word for the
dashboard: "я думаю о том чтобы сделать вход в нее по той же сессии что и все
остальное, только пользователь должен быть привелигирован". Being an operator is
a flag on the account's row in `cabinet_accounts`, closed to input from the
browser like `merchantId`, and only a subcommand of `pnpm account` at the
server's terminal writes it. An operator signs in once like anybody, writing
the row, and is flagged afterwards. `/admin` opens for a session whose account
carries the flag, and everybody else, signed in or not, gets one answer, the
ordinary answer of a page that does not exist. When the flag cannot be
confirmed because the cabinet does not answer, the answer is the same: the
dashboard fails closed. The dashboard stays read-only.

## Cases the scanner's and the cabinet's suites answer for

| Where the person is | What they hold | What happens | Ends at |
|---|---|---|---|
| a sign-in link with no destination | reports and no merchant | the link leads to their latest report, never to the screen that makes a merchant | the latest report |
| a link to a report or the cabinet from another site | a session | the cookie rides the navigation; nothing is made, and no request but the session's own is finished | that page |
| the cabinet, the first time | a session, no merchant | one control; its press makes the merchant and key | the seller-name screen |
| `/admin` | anything but a session whose flag the cabinet confirms | the answer of a page that does not exist | nowhere |
| a public scanner page, the cabinet unreachable | anything | the page says it cannot tell who is visiting | that page |
| a link pressed twice, expired or unknown | no session | refused the same way | the sign-in page |
| the same link | a live session | nothing is said about the link's address | that person's start |

## Consequences

Out: the scanner's report sessions, their cookie and its landing page for links;
the handoff from a report into the cabinet and the receipt the two processes
passed between them; and the whole `/admin` block of the edge configuration,
basic auth and headers alike, with its `ADMIN_BASIC_AUTH_*` values. The
dashboard has no protection of its own, so the refusal lives in the application,
and a routing test proves that `/admin` and every path under it answer a visitor
without the flag as a page that does not exist. A request whose link was
consumed but whose person never arrived waits, and asking again while signed in
finishes it. A deletion request at the scanner removes the lead, and with it the
address's reports, and for a person who owns no merchant their row and sessions;
a merchant's owner is removed by rules not yet built (ADR-0014).

What it costs. The mailbox is the whole key: losing it loses the cabinet, and
whoever reads a merchant's mail is that merchant. A refused request says when
the next link may be asked for, which reveals the timing of an address's last
link, never whether it has an account or a report. Delivery is the single point
of failure of the way in, measured, with the resend on the same screen, and the
cabinet's absence stops every sign-in, every full report and the dashboard. A
session left open on a shared computer opens everything its person may see until
somebody signs out, though it moves no money by itself, because a wallet change
waits and is announced (ADR-0019). A second factor outside the mailbox, optional
and not a condition of live publication, is the second stage Dmitry agreed in
principle on 2026-09-17, and until it lands none of it is assumed to exist.

Rejected: **a session per application with a handoff between them** — a person
signed in at one surface is a stranger at the next, and the cookie path between
them is no boundary inside one origin (ADR-0009 §6). **A mailed login and
password** — a plain-text secret in mailboxes and logs, doing what the link
does. **Two identity stores** — everything about a person written twice, and two
places for a deletion to miss. **The password as a second factor** — recovered
through the same mailbox, it is not a second one; passkeys belong to the second
stage. **The invitation as a hidden door** — it stops nobody; the door belongs
at publication, where a stranger's words reach a buyer. **Operator addresses in
configuration** — a privilege kept apart from its account, granted before the
address is proved and changed by editing a server's file. **Basic auth in front
of `/admin`** — a shared password that names nobody and cannot be taken from one
operator alone.
