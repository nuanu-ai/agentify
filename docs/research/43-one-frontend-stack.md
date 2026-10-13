# One frontend stack: the spike, registered before it starts

Date: 2026-10-12. A pre-registered experiment. The question, the measurements,
the predictions and the rule that turns them into a decision are fixed here
before any code is written, and the rule is executed as written. The results
are appended under their own heading once the spike ends; nothing above that
heading changes after this commit.

## The question

Can one web framework, React Router 7 in its framework mode, carry every
surface a person uses on the origin — the scanner's pages, the landings, the
dashboard and the operator's admin — while running inside the existing `app`
process, and make the interface react at once on a slow link?

Today four stacks draw those surfaces. The scanner is a Next.js application;
the dashboard and the stand are HTML strings built by hand on the server; the
merchant landing is a static file; the documentation is VitePress. One
stylesheet of tokens is shared, but no component can be, so headers, footers,
inputs and badges are written once per surface, and every value inserted into
a dashboard page is escaped by hand.

## What was measured before the spike

These figures were taken on 2026-10-12 against production from a link with a
round trip of about 450 ms to the host and about 260 ms to the nearest
content-delivery point. They describe today and are the baseline the
predictions are read against.

- The server's own time is close to zero: a static file and the dashboard's
  sign-in page both answer in one round trip.
- The scanner's front page transfers 259 KB of JavaScript compressed (929 KB
  uncompressed) in eleven files. One chunk of 277 KB uncompressed is mostly
  the schema library zod, shipped to the browser for a page with one input.
- The dashboard ships no JavaScript and a page of about 1 KB, but its
  stylesheet, fonts and logo are served without a cache lifetime, so every
  navigation waits for a second, serial round trip to revalidate the
  stylesheet before it can paint. An action is a form post answered by a
  redirect, which is two more round trips, with no feedback on the page while
  they run.

## What the spike builds

The spike lives on the branch `spike/one-stack` and is deleted once its
conclusions are in a research note on `main`. It builds:

- A React Router 7 application, compiled by Vite, whose request handler is
  mounted inside the `app` process on the dashboard's listener under a prefix
  of its own, so the existing pages keep working beside it.
- Screen A, the scanner's front page: the same content as today's `/`, with
  the scan form submitting to the existing scan endpoint.
- Screen B, the dashboard's list of orders and the page of one order, with
  one action a merchant takes there. Their data comes from the gateway's
  application called inside the process as the signed-in merchant, through
  the existing session, exactly as today's dashboard calls it.
- A first set of shared components — a button, a field and the header — used
  by both screens and styled by the shared token classes.

## How it is measured

Playwright drives Chromium against production builds on the local stack,
with network emulation adding 300 ms to every round trip and the CPU slowed
four times. Every figure is the median of five runs, and each is taken for
the spike's screens and for today's equivalents (`/` on Next.js and the
dashboard's orders pages as HTML strings) under the same conditions.

- M1. JavaScript transferred, compressed, for Screen A.
- M2. JavaScript transferred, compressed, for all of Screen B's routes
  together, counted once since they share a cache.
- M3. Largest contentful paint of Screen A on a cold load.
- M4. Time from a click on the action to the first visible change on the
  page.
- M5. Time from a click on an order in the list to the order's content being
  visible, once after the pointer rested on the link for 300 ms and once
  without.
- M6. The server's own time for each route, 95th percentile, read from a
  `Server-Timing` header.
- M7. With JavaScript disabled, the scan form, the navigation and the action
  each still work.

## Predictions

- P1. The handler mounts in the `app` process on Express 5, and Screen B's
  data is read and its action taken through the gateway's application in the
  process, with no new credential, key or route.
- P2. M1 is at most 100 KB.
- P3. M2 is at most 150 KB.
- P4. M4 is at most 100 ms.
- P5. M5 is at most 100 ms after the pointer rested, and at most one round
  trip plus 150 ms without.
- P6. M6 is at most 50 ms on every route.
- P7. Everything M7 lists works without JavaScript.
- P8. `pnpm check`, `pnpm typecheck` and `pnpm test` pass with the spike in
  the tree, and the `app` image gains one build step and no second runtime.

## The decision rule

1. If P1 fails, React Router 7 cannot host the dashboard inside the process
   that holds the gateway. That result is recorded, no migration starts, and
   the next comparison is a web application in a process of its own, priced
   with the authentication it would need to reach the gateway.
2. If P1 holds and P2 to P6 each hold, React Router 7 becomes the one stack
   for every surface a person uses. The choice is recorded in research, and
   the migration starts with the dashboard, then the scanner's pages, then the
   landings; the Next.js application is removed in the change that moves its
   last page.
3. If P1 holds and any of P2 to P6 misses, the cause is found before
   anything is decided. A cause in the spike's own code is fixed, the screens
   are measured once more, and this rule is applied to that second
   measurement, after which a miss that remains counts as a cause in the
   framework. A cause in the framework's own weight sends Screens A and B to
   Astro under the same measurements and the same P1; the stack that meets
   more of P2 to P6 is chosen, and a tie goes to React Router 7, which keeps
   the scanner's existing React components.
4. A miss of P7 or P8 is a defect of the spike to fix, not a verdict on the
   stack, because React Router's forms are ordinary HTML forms and its build
   is one Vite step.

The documentation portal is outside this question: VitePress is a generator
of documentation rather than an application stack, and whether it joins the
one application is decided separately.

## Results

Taken on 2026-10-12 on the branch `spike/one-stack`, which held the spike's
code and was deleted once these results reached `main`. The measuring script
is kept beside this note, in `43-one-frontend-stack/measure.mjs`, and what it
printed for each measurement is in `43-one-frontend-stack/results/`.

### What was built and how it was measured

The spike was a workspace package of its own: React Router 7.18.4 in
framework mode with React 19.2.7, compiled by Vite 7. Its handler is mounted
by `apps/app` on the dashboard's listener under `/dashboard/spike`, ahead of
today's dashboard pages, through `@react-router/express` on Express 5.2.1, so
it sits behind the same Caddy route and the same session cookie. Screen A is
the scanner's front page at `/dashboard/spike/`, and its form posts to a route
action that sends the address on to the scanner's existing endpoint,
`POST /api/v1/scans`, and redirects the browser to the scan it opened. Screen B
is the orders list at `/dashboard/spike/orders` and one order's page at
`/dashboard/spike/orders/<id>`; the action on the order's page pauses or
resumes the card the order was bought from, which is the one switch today's
dashboard offers that concerns an order, because today's orders screen itself
has no action. A button, a field and the header are shared by both screens and
styled by the classes of `packages/visual/tokens.css`. Every answer carries
`Server-Timing`, and the built scripts, stylesheet and faces carry a content
hash and a year's cache lifetime.

Both screens and today's equivalents were measured on one local stack built
from this branch: the Next.js scanner from its production image, today's
dashboard untouched, Caddy in front of both. Chromium was driven by Playwright,
with 300 ms added to every request by the browser's network emulation and the
CPU slowed four times, and each figure is the median of five runs. The data was
one merchant signed in through the dashboard's one-time link, the two cards the
repository's mock merchant publishes, and twelve test orders bought with
`pnpm buy`. The scanner's worker was not started, so the scans the forms opened
were queued and no site was ever fetched.

### The table

"First" is the first measurement of the spike, "second" the one taken after
the causes in the spike's own code were fixed. The decision rule is applied to
the second. Today's column is from the second measurement; in the first it
differed by under 25 ms or not at all. M2 counts every script the browser
loaded in one cold session that opened the list, opened an order, pressed its
switch twice and went back to the list.

| Measure | Spike, first | Spike, second | Today |
| --- | --- | --- | --- |
| M1. Script transferred, Screen A, compressed | 112.6 KB | 111.6 KB | 226.3 KB |
| M2. Script transferred, all of Screen B, compressed | 113.0 KB | 111.7 KB | 0 KB |
| M3. Largest contentful paint, Screen A, cold | 692 ms | 692 ms | 716 ms |
| M4. Click on the action to the first visible change | 32.6 ms | 32.0 ms | 950.9 ms |
| M5. Click on an order to its page, after a 300 ms rest | 140.5 ms | 109.9 ms | no such page |
| M5. The same, without a rest | 466.5 ms | 341.7 ms | no such page |
| M6. Server's own time, 95th percentile, worst route | 6.1 ms, scan action not validly timed | 25.8 ms | not measurable |
| M7. Scan form, navigation, action with no script | refused by the scanner's limits, works, works | works, works, works | fails, works, works |

M6 per route in the second measurement, read from `Server-Timing` over forty
requests each: the front page 5.9 ms, the orders list 5.7 ms as a page and
2.4 ms as data, one order 2.0 ms as a page and 1.6 ms as data, the card switch
2.8 ms, and the scan action 25.8 ms, of which 24.8 ms is the scanner's own
answer. The scan action was timed over eight new scans rather than forty,
because the scanner takes ten scans an hour from one address. Today's routes
carry no `Server-Timing` and were left as they are, so the one figure both can
be compared on is the time to the first byte through Caddy on the same machine:
today 6.8 ms for the front page, 3.0 ms for the orders list, 2.6 ms for the card
list and 3.4 ms for the card switch; the spike 7.3, 7.3, 3.7 and 5.5 ms for
its front page, orders list, order page and switch.

Today's dashboard has no page for one order and its orders list links nowhere,
so M5 has no equivalent. For scale, a click on a section in today's dashboard,
to the first paint of the page it opens, took 640 ms. Today's M4 is the same
card switch on today's card list: a form post answered by a redirect, the page
it redirects to, and the revalidation of its stylesheet, which is three round
trips before anything on the page changes. The spike's 32 ms is the press drawn
on the frame it happened in; the server's answer was drawn 649 ms after the
click.

### The predictions

P1 holds. The handler runs inside the `app` process on Express 5, and Screen B
reads the session through the dashboard's own lookup and every order, card and
switch through `gatewayFor`, the calls today's dashboard makes on the gateway's
application, with nothing added to the gateway, the contract's routes or the
credentials. P2 misses: 111.6 KB against 100 KB. P3 holds: 111.7 KB against
150 KB. P4 holds: 32.0 ms against 100 ms. P5 misses in its first half and holds
in its second: 109.9 ms after the rest against 100 ms, and 341.7 ms without it
against the 450 ms that one round trip and 150 ms make here. P6 holds on every
route, the worst being the scan action at 25.8 ms against 50 ms. P7 holds in
the second measurement. P8 holds: with the spike in the tree `pnpm check`
exits 0 with the 28 warnings that were there before it, `pnpm typecheck` exits
0 in all seventeen packages that declare one, and `pnpm test` exits 0 with 3319
tests in 218 files and the 28 operational tests; the app image gains one `RUN`
line that builds the spike and no runtime besides Node.

### Causes, the fix, and the rule

After the first measurement P2 and both halves of P5 missed, so the causes
were looked for before anything was decided.

P2's cause is the framework's weight. Of the 112.6 KB, about 62 KB is the
React DOM client and about 46 KB is React together with React Router's
runtime; the spike's own route module, components and route manifest are
about 5 KB, and removing all of them would still leave the screen above
100 KB. Nothing was changed for it.

P5 without the rest missed by 16.5 ms, and the cause was in the spike's own
build. A component two routes share had become a chunk of its own; on a click
React Router fetched the order's route module and only then discovered the
chunk it imports, a second round trip that the hover prefetch, firing while the
pointer sat on the link, half hid. With the shared components bundled into one
chunk, which every page has loaded with its header, the same click took
341.7 ms. The no-script scan form failed in the first measurement for a
reason outside the spike, the scanner's rate limits (ten scans an hour from one
address, ten a day for one site), and its failure showed a defect inside it:
the refusal was not shown to a browser with no script. That was fixed in the same change.

P5 after the rest improved with that fix and still missed, and its remaining
cause is the framework's prefetch timing against the registered conditions.
React Router begins an intent prefetch 100 ms after the pointer arrives, so the
order's data left about 125 ms after the pointer and, with 300 ms of latency,
arrived at about 430 ms; the click came at about 346 ms, which is Playwright's
300 ms wait and its own overhead, and the page was drawn when the prefetch
landed. The spike could only remove that by replacing the framework's intent
prefetch with one of its own, started the moment the pointer arrives or when
the list renders, and that was not done.

The second measurement therefore leaves P1 holding with P2 and P5 missing, and
rule 3 applies to it. A miss that remains after the fix counts as a cause in
the framework; P2's is the framework's own weight, and that sends Screens A and
B to Astro under the same measurements and the same P1. React Router 7 meets
three of P2 to P6, P3, P4 and P6, so Astro is chosen only if it meets four or
more, and a tie keeps React Router 7. That comparison is the last section of
these results.

### What surprised

Chrome hands a prefetched answer to the click that follows only while the
answer is fresh. Under `no-cache`, and under the `no-store` today's dashboard
sends on every page behind its gate, a hover's prefetch of an order's data was
thrown away and fetched again on the click; React Router's prefetch only works
when its data may be kept. A dry run before the first measurement showed it,
and the spike's data answers became `private, max-age=10` while its pages stay
`private, no-cache`. That keeps ADR-0026 §3, which forbids a shared cache, and
gives up something `no-store` held: this browser's own cache now keeps an
order's data for ten seconds. A post to the same page does not drop the kept
answer, because the data's address carries `_routes` and the post's does not;
the dashboard therefore gives the browser a new cookie with every press and
keeps page data per cookie (`35-one-process.md`).

The front page paints its largest element at the same moment in both stacks,
692 and 716 ms, because in both the heading waits for the document and the
stylesheet and for nothing else; the script loads after the paint and neither
helps nor hurts it. The scripts differ by half, 111.6 against 226.3 KB, and
that half is still over the line.

The server does almost nothing: the calls into the gateway's application in
the process took a millisecond or two for a whole page, and the slowest route
is the one that leaves the process for the scanner.

React Router reads a redirect to a bare path as one inside its own prefix, so
sending a browser to `/dashboard/sign-in` or to a scan has to be written as a
whole address, or it lands under `/dashboard/spike`.

### What the figures do not say

The latency is the browser's emulation: 300 ms is added to each request's
answer, not to each connection, and the local origin is plain HTTP/1.1 with no
TLS, so a real first visit over a slow link costs more round trips than these
cold loads show, on both stacks alike. "Compressed" is what Caddy sent, zstd to
Chromium, since Caddy's own encoders are zstd and gzip; the same files under
brotli at its highest quality would be 93.2 KB for Screen A, under the line, so
P2's verdict depends on an encoder the deployed edge may or may not use. The
screens hydrate the whole page because that is what the framework does by
default; rendering Screen A without React Router's scripts would ship no script
at all and also no feedback on the press, and that variant was not measured.

The three images were built from local copies of the repository's Dockerfiles
that added environment lines sending the registry traffic through a proxy on
the host, because Docker Desktop on this machine dropped pnpm's concurrent
fetches, and kept them out of what runs; what the images contain is what
the repository's Dockerfiles build. The first measurement had three defects of
its own instrument, recorded in the commit that keeps its output: today's M4
pressed the switch that stops all selling instead of a card's; the scan
action's M6 sent its forty samples for one site and without the scanner's
visitor cookie, so once the scanner's limits were reached its samples timed
refusals rather than scans; and M7's scan form
then met the same limits. The second measurement took all of them again with
the instrument fixed, after the limits in the local stack's database were
cleared.

### The Astro comparison that rule 3 asks for

Screens A and B were built a second time in Astro 7.3.8, the current release,
as a workspace package of its own on the same branch, and measured on
2026-10-12 by the same script under the same conditions: Chromium driven by
Playwright, 300 ms added to every request, the CPU slowed four times, the
median of five runs, production builds on a local stack rebuilt from the
branch and seeded the same way. The Astro screens are server-rendered pages.
The only script they ship is the press drawn at once on the scan form and on
the card switch, written inline on the page that uses it, and Astro's own
hover prefetch, one file of 1.2 KB. The switch posts in the background and the
server's answer carries the card's new state; without script the same form
posts as an ordinary form and is answered by a redirect. The shared button,
field and header are Astro components drawn by the same token classes, and the
stylesheet is the React Router spike's own file. Screen B's documents are sent
with `private, max-age=10`, so the page a resting pointer fetched is the page
the click opens.

Astro's order page is a page of its own rather than a view inside the list's
page, so M5 for Astro is timed from the click to the order's heading painted in
the document the click opened, and M7 follows the page loads. M1 to M4 and M6
use the same functions as the React Router screens with Astro's prefix.
Today's surfaces were measured again on the rebuilt stack as a control and
came within 24 ms of the second measurement on every figure; the column below
is the second measurement's, as in the first table.

| Measure | React Router 7, second | Astro | Today |
| --- | --- | --- | --- |
| M1. Script transferred, Screen A, compressed | 111.6 KB | 1.2 KB | 226.3 KB |
| M2. Script transferred, all of Screen B, compressed | 111.7 KB | 1.2 KB | 0 KB |
| M3. Largest contentful paint, Screen A, cold | 692 ms | 672 ms | 716 ms |
| M4. Click on the action to the first visible change | 32.0 ms | 16.2 ms | 950.9 ms |
| M5. Click on an order to its page, after a 300 ms rest | 109.9 ms | 129.5 ms | no such page |
| M5. The same, without a rest | 341.7 ms | 371.2 ms | no such page |
| M6. Server's own time, 95th percentile, worst route | 25.8 ms | 47.7 ms | not measurable |
| M7. Scan form, navigation, action with no script | works, works, works | works, works, works | fails, works, works |

Beside M1 and M2 stand two facts that are not scored. The first is the
encoder: every compressed figure is what Caddy sent, zstd. Under brotli at its
highest quality, which Caddy's own encoders do not offer, the React Router
screens' scripts would be 93.2 KB for Screen A and 93.3 KB for Screen B, and
Astro's 0.9 KB for both. The second is the script a page carries inside its
own document, which M1 and M2 do not count because they count the script files
the browser fetched: 333 characters on Astro's front page, none on its list
and 1,102 on an order's page; 2,985, 3,028 and 4,592 on the React Router
screens, which is the route data and the start-up the page hydrates with; 22,644 on today's front
page, and none on today's dashboard.

M6 per Astro route over forty requests each: the front page 0.4 ms, the
orders list 2.9 ms, one order 1.6 ms and the card switch 2.0 ms. The scan
action, timed over eight new scans for the scanner's rate limit, came to
47.7 ms, of which 47.0 ms was the scanner's own answer. At eight samples the
95th percentile is the slowest of them, so Astro's worst route sits under the
line by the margin of the scanner's slowest answer that run; Astro's own share
of it was under a millisecond. The time to the first byte through Caddy on the
same machine was 1.5, 5.7, 3.3 and 3.5 ms for the front page, the list, the
order and the switch.

The two stacks differ where their mechanisms differ. Astro's press is drawn in
16 ms, where the page's whole script is the handler of that one form, and the
server's answer is drawn 316 ms after the click, one round trip, because the
post answers with the card's new state; React Router took two, 649 ms, because
after an action it fetches the page's data again. Astro's click without a rest
is a whole page load, 371 ms against React Router's 342 ms. Its click after a
rest misses for the same reason React Router's does: Astro starts the prefetch
80 ms after the pointer arrives, the answer needs 300 ms to come back, and the
click at about 346 ms waits for the rest of it.

### Astro's predictions, and the rule's outcome

P1 holds for Astro. The node adapter's handler in middleware mode is mounted
by the app process on the dashboard's listener under `/dashboard/spike-astro`,
on Express 5, and it is handed as its locals the very context the React Router
screens read: the session through the dashboard's own lookup and every order,
card and switch through `gatewayFor`, with nothing added to the gateway, the
contract's routes or the credentials. Astro's own check of a post's origin is
turned off and the mount's check, the same one the React Router screens and
the dashboard use, stands in front of it, because Astro compares against a host
fixed at build time.

P2 holds: 1.2 KB against 100 KB. P3 holds: 1.2 KB against 150 KB. P4 holds:
16.2 ms against 100 ms. P5 misses in its first half and holds in its second:
129.5 ms after the rest against 100 ms, and 371.2 ms without it against
450 ms. P6 holds on every route, the worst being the scan action at 47.7 ms
against 50 ms. P7 holds: the scan form, the navigation and the action all work
without script. P8 holds with Astro in the tree: `pnpm check` exits 0 with the
same 28 warnings, once biome is told not to judge unused names in `.astro`
files, whose markup it does not read; `pnpm typecheck` exits 0 in all eighteen
packages, `astro check` among them with no errors; `pnpm test` exits 0 with
3319 tests in 218 files and the 28 operational tests; and the app image gains
one more `RUN` line and no runtime besides Node.

Astro meets four of P2 to P6, P2, P3, P4 and P6. React Router 7 meets three,
P3, P4 and P6. Rule 3 as written chooses the stack that meets more of them, so
the outcome is Astro. The rule names the choice and nothing further; the order
of the migration in rule 2 was written for React Router 7, and whether it
carries over to Astro is not in this registration.

## The decision

On 2026-10-12 the product owner chose React Router 7 as the one stack for
every surface a person uses, over the outcome of the registered rule. The
rule was executed as written and its outcome stands above as the record of
what was measured; the choice departs from it for two reasons that lie
outside what the rule counted.

The first is that the rule scored speed alone and priced nothing of what a
stack costs to own. The second is that the one prediction separating the two
stacks, P2, was decided by 11.6 KB under the zstd the local Caddy happened to
serve: under brotli the same React Router scripts are 93.2 KB and meet it,
which would have made the count a tie, and a tie goes to React Router 7.
Read as a person would feel them, the measurements put the two stacks level:
the front page paints within 20 ms of each other, both answer a press well
under the 100 ms at which a delay is noticed, and React Router moves between
pages faster, because its navigation stays inside the page.

What decides it is the cost. With React Router 7 the pages and every
interactive part are written in one component language, so the shared
button, field and header exist once; with Astro the pages are `.astro`
components and anything interactive — the card payment, the scan's progress,
the consent banner — remains a React island, so the shared components would
exist twice. React Router gives pending states, optimistic updates and
revalidation as part of the framework, where the Astro screens reached their
16 ms with a script written by hand for each control, which does not scale to
a dashboard that grows. And the scanner's sixteen interactive React components
move into React Router largely as they are, where Astro would have its pages
rewritten around them.

The cost accepted is about 110 KB of script, compressed, on every page that
hydrates. Two measures take most of it back: the built assets are compressed
with brotli at build time and served precompressed, and the landing and
methodology pages are rendered without any client script, which React Router
allows route by route.

The migration follows rule 2's order: the dashboard first, then the
scanner's pages, then the landings, and the Next.js application is removed in
the change that moves its last page. A future registration prices the cost of
ownership in its rule, not only the speed. The move starts on React Router 8,
the current major of the same framework, measured equivalent: the brotli
script of the first moved dashboard pages is 91.0 to 91.8 KB a page on 8.4.0
against 91.7 to 92.4 KB on 7.18.4.
