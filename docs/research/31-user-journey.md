# The path through one site: scanner, cabinet, documentation

Date: 2026-09-21. A design note about screens and flows, rewritten freely;
not a decision. Written on Dmitry's word of the same day, which accepted the
four changes below, and revised after an adversarial review of the first
draft by an agent with a clean context.

## What this note settles

Agentify is one product with several surfaces on one origin. The scanner is
the public front, where the owner of an ordinary online business enters an
address and reads what their site exposes to AI agents, as a report of named
checks. Beside it stand the cabinet, where a merchant holds the cards they
sell, the orders and the key their code calls with; the documentation a
merchant's engineer reads; and the gateway that agents buy from. They do not
look like one product yet: a visitor meets two brands and two navigations on
one address. The question this raised was how people should be routed:
everyone into the cabinet, or a softer entry where each surface shows the
other and the documentation is always in view.

The answer is that two questions were being asked as one. The first is where
a stranger lands and how they reach the cabinet. The second is how a person
who already holds something reaches it every day. The image used in earlier
discussions, that the scanner is the porch and the cabinet is the house,
answers only the first question. Whoever lives in the house does not come in
through the porch each morning; they have a key.

The key exists already. ADR-0026 gives the cabinet its own door: one field
for an address, one link mailed to it, and that link lands in the cabinet,
not in the scanner. A cabinet session lasts past one visit, and the address
`/cabinet` can be bookmarked. Nothing in a merchant's working day passes
through the scanner. The discomfort of "every day from the mail to the
scanner, from the scanner to the cabinet" is the first-visit path read as the
daily one. What is missing is not a shorter path but a visible door: a
merchant who opens `agentify.ad` today sees a diagnostic landing whose header
has no entry to the cabinet at all.

Two words are used below in a fixed sense. The doors are two links, Docs
and Cabinet, that lead to the documentation and to the cabinet's sign-in
page. The second door is one line under the scan form on the front page
that leads to the page about selling to agents. The benchmark is the average
score of completed scans in the same segment, shown on a report once thirty
such scans exist; the segment is the audience a landing page addresses,
owners, online stores or local businesses, and the scan started from that
page carries it.

## Who arrives

Four kinds of people reach the site, and the routing has to be right for
each, not for an average of them.

The owner of any site with a public address is the scanner's own audience:
the segment pages address owners, online stores and local businesses. Most
of them want the diagnostic and nothing after it. The cabinet is five tabs,
Cards, Orders, Receipts, API Keys and Settings, an integrator's tool; an
owner of a service business who is led there finds empty cards and a key
they have no use for, and leaves with the question of what that was.

The merchant is the owner of a business whose goods survive being delivered
twice: access, a key, a link, a subscription. That is the pilot's limit,
stated on the documentation's front page, and it is the only audience for
whom the cabinet is the point. The merchant's engineer is a third kind: sent
a link by the owner, they land on the documentation and need the cabinet
for the key.

The fourth kind, the developer of an agent that would buy here, is served by
no page today. Research note 09 already found the product vision merging
that developer with the person who sends the agent; a page for them is not
this note's subject and nothing below is built for it.

So "lead everyone to the cabinet" is right for the second and third kinds
and wrong for the first. The porch keeps a bench: the report is a complete
result on its own, and the door to the house is offered in words that say
who it is for. ADR-0026 §5 opens the cabinet to anyone who can read their
mail. That is an open door, not a funnel.

## What the site does today

These are facts read from the code on 2026-09-21, not a critique of whoever
wrote them; every one of them made sense in the product it came from.

The front page `/` answers with a permanent redirect to `/owner`, the
landing of the owner segment, titled "Website diagnostic for business
owners" (`apps/web/app/page.tsx`). Its hero does not mention selling to
agents; the header's "Agentic Shop" and the footer's "For merchants" are the
only signs of it. The redirect is served with `Cache-Control: no-store`,
verified against the live site on 2026-09-21, so browsers do not remember it
and moving the front page has no cached tail.

The public header carries four links: Agentic Shop, Scanner, Methodology,
Privacy (`apps/web/components/site-chrome.tsx`). Neither the cabinet nor the
documentation is among them. That header is rendered by the landing pages
only; the trust pages, methodology, privacy, terms, the scanner's own page,
render a header of their own with three links and no door either
(`apps/web/components/editorial-page.tsx`). The footer names "For merchants"
among the segments and links the same page. The brand mark on every scanner
page leads to `/owner`.

Selling to agents lives at `/agentic-shop` as a subbrand, "Agentify
Agentic Shop", with a lockup, a title, a social image and a navigation of
its own (`apps/web/app/agentic-shop/page.tsx`). Its header and its last
section open the cabinet's door. Its footer's "Explore Agentify" leads back
to the owner landing. The historical privacy notice under the same prefix
renders the same lockup, and the site's `llms.txt` lists the page under the
second name.

The full report offers the cabinet under the heading "Your cabinet" with the
sentence "Manage cards and integrations through the same verified email"
(`apps/web/app/report/[scanId]/page.tsx`). Cards and integrations are words
an integrator has a referent for and a site owner does not. Below the checks
the same page asks "What do you want to do next?" with three choices, fix it
with AI, send to a developer, share with my team, and shows "Waitlist #N"
and, beside it, the benchmark. The choices are recorded as an answer on the
visitor's waitlist entry. This block is the former product's survey for a
queue that no longer exists: the cabinet is open to anyone, and the report
already carries the fix prompt, the developer brief and the share control
the three choices point at. The number is the ordinal of the entry among
all entries and promises nothing. The benchmark is a different thing that
happens to share the block: the methodology page promises it, and it is
read from the scans table by the report itself.

The landing analytics do not read a page's segment; they match the path
against the three segment addresses (`apps/web/components/analytics-runtime.tsx`)
and derive the variant name from the segment a second time, beside the
variant the landing configuration already carries.

The cabinet's only way out is "Docs →" and the brand mark, which leads to
`/` (`apps/cabinet/src/html.ts`). The documentation links the cabinet's door
from its front page and from the quickstart.

## The journey

Where each person lands, what they see and where they go.

| Who and when | Lands on | Sees | Goes to |
|---|---|---|---|
| a stranger, first visit | `/` | one sentence naming both things: what the site shows to agents and how to sell to them; the scan as the first action; the doors in the header; the second door under the form | the scan, then the report |
| a site owner, after the report | the report | how to fix the site: the prompt and the brief; the benchmark beside the score; one paragraph saying who the cabinet is for | stays, or the cabinet |
| an engineer sent by the owner | `/docs` | the quickstart and the cabinet's door | the cabinet |
| a merchant, working day | `/cabinet`, a bookmark, or Cabinet in the header of any landing or trust page | a live session opens the cabinet at once; otherwise the one field and the mailed link | the cabinet, never the scanner |
| a merchant inside the cabinet | the cabinet | Docs | the documentation, and back |
| a site owner, scanning again | `/`, or the report link from the mail | the scan form on `/`; the report by its own link, which the thirty-day report cookie opens without another message. `/` does not list a visitor's reports | the report |

## The four changes

Each is one commit, written red then green, and each is reviewed by an
agent with a clean context before it is committed; they land in the order
given, because the second's test asks for the doors the first adds. None of
them touches the merchant's contract, the `/v0` and `/x402` routes and the
SDK, nor a security boundary: no token, cookie, session or handoff changes.
The third does remove a member from the JSON the scanner's own report route
answers with and deletes one route of that same private API, and drops
three columns from a scanner table; that is the charter's "delete first"
applied, a rule already recorded, so no new decision is owed. ADR-0026 is
edited in the first change, where its table of ways in gains a row, and in
the fourth, where it names a page by its old name.

### 1. The doors in every public header

The header of the landing pages and the header of the trust pages both
render one shared element with the two doors: Docs, leading to `/docs/`, and
Cabinet, leading to `/cabinet/sign-in`. The header of the `/agentic-shop`
page gains Docs beside the cabinet control it already has. The words are the
ones the destinations use of themselves: the portal says Docs in its corner
and the cabinet already links it under that word; the sign-in page opens
with "Enter your email address. We will send one link that signs you in or
makes your cabinet when you open it", which is the whole of what a curious
owner needs to know before pressing. The footer keeps its groups. The report
page is not public and keeps its own section as its door.

A person who already holds a cabinet session and presses Cabinet is sent
straight to their cards: the sign-in route answers a live session with a
redirect and asks for nothing. ADR-0026's table of ways in gains that row,
"any public header, Cabinet pressed", and the cabinet's suite answers for it.

The test renders both headers and asks for both addresses; it fails when a
merchant on a public page has no way in except memory. The cabinet's test
signs a person in, asks for the sign-in page again and expects the cards.

### 2. A front page that names both things

`/` stops redirecting and renders the owner landing, whose hero is rewritten
to say in one sentence what the site does: it shows what a site exposes to
AI agents, and it lets a business sell to them. The scan form stays the
first action, because it is cheap, needs no account and serves every
audience. The second door sits under the form for those who came for the
selling. The landing configuration gains one optional field for it; the
store and local pages leave it empty and render as before.

`/owner` becomes a permanent redirect to `/`, the mirror of what `/` was,
and every internal link that pointed at `/owner`, the brand mark, the
footer's "For owners", the retry and back controls of the scan screens, the
web manifest, is pointed at `/`. The front door has been the owner segment
since the redirect existed, so the scans started there carry the same
segment as before and the benchmark's cohort does not change meaning. The
landing's variant name is bumped, because the words a visitor saw are
different and the variant is what names them.

The landing analytics stop matching the path and read the segment and the
variant from attributes the landing page renders on itself, the same way
the report page already announces the scan it shows. That is what makes `/`
count as a landing at all; without it the front page would be the one page
absent from the numbers this note says must decide the funnel question.

The public page list that feeds the sitemap, the `llms.txt`, the Markdown
rendering for agents and the content-negotiation proxy names `/` in place
of `/owner`; the redirect settles the canonical address without a second
page to compete with it.

The shape of the front page is also asserted outside the application: the
release gate, the CI self-readiness run and the smoke scripts all knew `/`
as a redirect and `/owner` as the page, and they move with the change, so
that the old address is now checked as a redirect whose response no cache
may keep. The request-class map that the observability package and the
Caddy files share counts `/` as a landing from now on, since that is what
it serves.

The test renders `/` and asks for the scan form, the doors and the second
door; a second asks the reader of the page's announcement, given a root that
answers attribute selectors the way the DOM does, for the segment and the
variant the page carries and for nothing when the page announces a segment
the product does not know. The Markdown rendering that agents read carries
the second door too, and a test asks for it. If the first fails, the front
page has gone back to being one product's page.

### 3. The report says who the cabinet is for; the survey goes; the benchmark stays

The section under the action panel keeps its control and changes its words.
It says that if what the owner sells can be delivered digitally, an access,
a key, a link, a subscription, the same address opens a merchant cabinet
where their engineer publishes the cards and takes the orders; and that if
not, this report is the whole result and the site can be scanned again at
any time. The control keeps its name, "Open your cabinet", because the
cabinet's door and the sell-to-agents page use it.

The benchmark moves out of the survey block and into the report's header,
beside the score and the coverage, as one line that renders only when the
sample gate is met. The methodology page's sentence, that benchmarks stay
hidden until the gate is reached, stays true as written.

The survey block goes, and with it what exists only for it: the client
component and its stylesheet, the route that stores the answer and its
request schema, the `waitlist` object in the report's response, the
analytics event named for the answer together with its property allowlist,
its once-key and its destination mapping, the route label in the
observability package, the fixture in the fix-prompt test, the sentence in
the card control that promised the waitlist was unaffected, and the steps of
the P4 integration test that saved an answer and counted its event.

The table `waitlist_entries` stays, under its name. In the code it is not a
queue: registration writes a row per lead and scan, the report refuses to
open without one, and access recovery joins it, so it is the record that a
lead registered for a scan. Three of its columns served only the survey: the
answer, the time it was given and the ordinal that was shown as a position,
with the unique index and the length constraint on them. A migration drops
all three in this same change. Said plainly: applying that migration to a
deployment deletes the answers visitors have typed so far, and nothing reads
them today. Renaming the table is left for a follow-up, because a name is
not a shape and a rename with data behind it deserves its own step.

The survey had roots outside the application too, and they go in the same
change: the operator's restricted worklist query read the ordinal and the
answer's time, the browser smoke pressed a survey button and waited for its
route, the request-class map in both Caddyfiles named the route, the
dashboard validator forbade a column that no longer exists, and the
migration rehearsal hashed every column of the registration table, which a
deliberate drop must not fail; it now hashes the columns that must survive.
The migration file itself says what it deletes, since that is where an
operator reads. The methodology page stops calling the benchmark's gate
"documented" and states it: thirty finished scans of the segment with
coverage of 70% or more.

The tests: the report's schema, which is strict, refuses a payload that
still carries `waitlist`, which is the negative control for the removed
member; the benchmark line renders the sentence with the average before the
sample when given one, so the two cannot swap, and renders nothing when
given none; the P4 integration test still verifies once, opens the report
and shares it, and counts the events that remain.

### 4. One name

The page at `/agentic-shop` keeps its address and loses its second
name. The header's link to it and the footer's say what it does, "Sell to
agents", and so does the page's title; the page's own lockup, its footer and
the historical privacy notice under the same prefix carry the plain brand
and lead to `/` like every other lockup, and the footer's second link to `/`
goes, one door per destination; the description, the social image and the
eyebrow that named "the Agentic Shop model" say the same in words rather
than a name; the `llms.txt` entry names the page; and ADR-0026 is edited
where it names "the Agentic Shop page". The address is kept because an
address is not a name: changing it breaks every link already shared and
gives a visitor nothing they can see. The privacy notice keeps describing
the application form that once existed and calls it the merchant
application form, since the form's old name was carrying nothing.

The test renders the page, the privacy notice and the header, reads both
pages' metadata, the social image's words and the `llms.txt`, and asks that
none of them carries the second name, comparing words the way a reader
meets them, with tags stripped and case ignored, so that a capitalised or
split rendering cannot slip through. This is a check on words, which the
charter is wary of; it is kept because the promise it guards is the one
Dmitry made, that the site has one name, and the file already holds a test
of the same shape for the application form that was removed.

## What is not done, and why

A shared session or a "my place" page above both applications is not built.
ADR-0026 rejected one session for both, and it would buy nothing a person
can see: whoever holds a report opens it by its link, whoever holds a
cabinet opens it by its own, and the header now shows both doors.

The cabinet does not link back to a report. A merchant at work does not need
the diagnostic, and the cabinet holds no knowledge of scans; adding a route
for it would widen the boundary ADR-0024 keeps for the sake of one link.

No page is written for the developer of a buying agent, the address of the
`/agentic-shop` page is not changed, and the waitlist table is not renamed,
for the reasons given above.

## What we do not know

Nothing counts how many people who open a report press "Open your cabinet",
nor how many of them go on to hold a merchant. No analytics event exists for
the press. The argument between a funnel and a soft entry is settled by
those two numbers, not by taste, and measuring them is a later, pre-
registered change with its own decision rule, not a side effect of this one.

## Where the work is tracked

The tracker did not answer this session, so no issue was opened for this
pass; Dmitry's word of 2026-09-21 stands in for it, and the four commits
name this note.
