# One documentation on the one stack: the spike, registered before it starts

Date: 2026-10-14. A pre-registered experiment. The candidates, the
measurements, the predictions and the rule that turns them into a decision are
fixed here before any code is written, and the rule is executed as written.
The results are appended under their own heading once the spike ends; nothing
above that heading changes after this commit.

## The question

On 2026-10-14 the product owner decided that the documentation stops being
split. Today two programs draw it. The merchant documentation at `/docs` is a
VitePress site, a documentation generator built on the Vue framework, while the
scanner's own documentation, the methodology at `/methodology` and the page
about the scanner's robot at `/scanner`, is drawn by the scanner's React Router
application from a text module of its own. The target is one documentation at
`/docs`, built with React Router 8, the framework the dashboard and the scanner
already run on, rendered to static files at build time and served by Caddy as
today, under the site header every other surface draws from the shared
component package `@agentify/ui`. It holds the merchant pages and a section
about the scanner. The privacy and terms pages stay pages of the site.

Whether the documentation moves is decided. This spike decides how: which
Markdown pipeline renders the pages, how the diagrams and the search are made,
whether the pages carry React's scripts in the browser, and what the move costs
the reader and the people who keep the site, before the migration branch
starts.

## What there is today

The merchant documentation is eight Markdown files in `apps/docs`. Seven are
pages; the eighth, `WRITING.md`, is the writers' guide and is not built. The
pages use three things plain Markdown does not have. A warning box is written
as a container, `::: warning <title>` up to a closing `:::`. An example payload
is not written into the page but included from a file with a line such as
`<<< @/examples/card/access-monthly.json`, six times on the card page, so that
the page shows the very file a test validates against the schemas. And the
orders page draws three sequence diagrams from `mermaid` code fences, which
VitePress's mermaid plugin draws in the reader's browser by loading the
diagram library there. VitePress gives every heading an anchor from its own
slug function, highlights code with Shiki at build time and builds a local
search: an index of the pages cut into sections at their headings, searched in
the browser by the MiniSearch library.

The site's look reaches the documentation by copying. The theme in
`apps/docs/.vitepress/theme` copies the palette of `packages/visual/tokens.css`
and adds a link back to the site, and the build hook in
`apps/docs/.vitepress/config.mjs` writes the notice that says which channel a
page belongs to, the surface marker, with its wording copied from
`packages/core`. Two tests exist only to hold those copies to their originals.
Caddy serves the built directory under `/docs` and fills the marker in at
request time from its environment through its templates.

The scanner's two pages are not Markdown. Their text is a structure in
`apps/web/content/public-editorial.ts`, drawn by the scanner at request time
with values from its environment: the site's address, the abuse address and the
operator's name. The address of the scanner page is written into the user agent
of the scanner's requests and of the browser observer's, as
`https://agentify.ad/scanner`, so that address must keep answering after the
move.

These tests read the Markdown and must stay green reading the same files:
`apps/gateway/src/portal-numbers.test.ts`,
`packages/contracts/src/portal-fixtures.test.ts`,
`packages/core/src/orders/portal-tables.test.ts`,
`packages/sdk/src/portal-codes.test.ts`,
`packages/sdk/src/portal-fences.test.ts`,
`packages/core/src/retired-claims.test.ts`,
`packages/core/src/deployment/portal-palette.test.ts` and
`packages/core/src/deployment/surface-markers.test.ts`. The script
`scripts/check-portal-render.mjs` checks after a build that every included
example reached the page that includes it.

## The candidates

### A. React Router 8, prerendered, with a markdown-it pipeline

A new application, `apps/docs-rr`, beside today's portal, so the baseline is
built from the same tree. It reads the seven pages and the examples from
`apps/docs` where they are and changes none of them. It is React Router 8.4.0
in framework mode with `ssr: false` and every page named in `prerender`, so the
build writes one HTML file per page and one data file per page for moving
between pages without a reload, and the result is a directory of static files
like VitePress's.

The Markdown is rendered at build time by markdown-it, the parser VitePress
itself is built on, so tables, inline HTML and line breaks come out as they do
today. The pipeline adds what the pages use: the `:::` container; the `<<<`
include, which reads the example file itself; heading anchors made by the same
slug function VitePress uses, so that every link into a page keeps its target,
including the dashboard's links such as `/docs/money#where-the-money-arrives`;
code highlighted by Shiki at build time; and every `mermaid` fence drawn into
an inline SVG at build time by the repository's Playwright Chromium, so a
reader's browser runs no diagram code.

Two other pipelines were considered and are not built. The unified family
(remark and rehype) is the common choice for React sites, but the container
and the include are VitePress syntax with no unified plugin of the same
meaning, so both would be new parser extensions, and its usual slug function
differs from VitePress's for a heading that begins with a digit: the first test
sale's "1. Make the merchant account ready" is `_1-make-the-merchant-account-ready`
under VitePress and `1-make-the-merchant-account-ready` under the other, so
anchors would move. MDX compiles a page into a React component, which puts the
page's content into its script, and reads `<` and `{` as code, so the include
lines would have to be rewritten and a writer's stray brace would break the
build.

Every page is drawn under `SiteHeader` from `@agentify/ui`, with the
documentation as a surface of its own, and with the palette imported from
`packages/visual/tokens.css` and the surface marker's wording imported from
`packages/core`, so nothing is copied. Beside the page stand a sidebar with the
same groups as today's plus a "Scanner" group, a list of the page's sections,
links to the previous and the next page, and a copy button on each code block.

The search is MiniSearch with the fields and options VitePress's local search
uses, over the pages cut into sections at their headings as VitePress cuts
them. The index is a static file written by the prerender, and it and the
search code are fetched only when the reader first opens the search.

The pages hydrate in the browser as every other surface's do, which gives
navigation between pages without a reload and a search box written in React.

The scanner's two pages become Markdown files in `apps/docs-rr/scanner/`, their
text taken from the scanner's text module as it stands, with the values of the
live channel, and their section anchors kept as the scanner's page has them
(`#scoring`, `#robots` and the rest) by VitePress's explicit heading id syntax
`{#id}`. They are served at `/docs/scanner` for the scanner's identity and
`/docs/scanner/methodology` for the methodology. The scanner's own pages and
the addresses `/scanner` and `/methodology` are not touched by the spike.

### B. VitePress kept, the baseline

VitePress stays, and the shared header is written a second time as a Vue
component, held to the React one by a test that compares their markup, the way
the palette is held today. The product owner rejected this for drift: the
header, the palette and the marker's wording would each exist twice, the
origin would keep a second frontend framework and its dependency tree, and
each copy needs a test that exists only to catch the copy falling behind. B
is not built beyond today's site. It is measured as today's build, so that what
a reader gains and loses with A is stated in numbers, and the rule below cannot
choose it.

Astro, Starlight and a documentation process with a server of its own are not
candidates: the first two are not the one stack, and static files already
answer every page.

## How it is measured

Both sites are built for the mount point `/docs/` on this Mac, an Apple Silicon
machine with Node 24.21.0, and served by a small local server that answers as
Caddy's `/docs` block does: the prefix stripped, a path tried as a file, then
with `.html`, then as a directory's `index.html`, the surface marker's
templates filled in as the test channel fills them, and the shared marks and
fonts served from `packages/visual/public`. Chromium is the one Playwright
1.61.1 installs for the repository. The script and what it prints are kept
beside this note, in `47-one-docs-stack/`.

A page is one of the seven merchant pages, which both sites have, or one of
the two scanner pages, which only A has. "Brotli" is a file's size compressed
by brotli at its highest quality, which is how the dashboard and the scanner
precompress their files; Caddy's portal block today sends zstd or gzip, so the
unit is chosen for comparison, not because it is what goes over the wire.

- M1. Script on a first visit: every script the browser requests while loading
  the page cold, with no input, until the network is idle, summed in brotli.
- M2. Stylesheets on a first visit, counted the same way.
- M3. The page's HTML, as built and in brotli, and the first visit's total of
  HTML, script and stylesheets in brotli.
- M4. Build time: from a tree with the build output and the build caches
  removed, wall-clock, the median of three runs. B is
  `vitepress build --base /docs/`; A is its whole build, the diagrams and the
  search index included. A's diagram drawing is also timed alone.
- M5. Diagrams: how many of the orders page's `mermaid` fences are in the
  built page as inline SVG, and how much script the orders page requests
  beyond the lightest page.
- M6. Search size: the index the browser fetches, and the script fetched on
  opening the search, in brotli.
- M7. Search quality: each registered query is typed into the built site's own
  search box in Chromium, and it hits when one of the first three results
  leads to the right page, at any section of it.
- M8. Content parity, read from the built HTML of each page's content area:
  every heading with its level, text and anchor; every table with the text of
  its cells; every code block's text; every included example's whole text,
  as `check-portal-render.mjs` compares it; one diagram per `mermaid` fence;
  and the address of every link. A difference is any of these present in B's
  page and absent or different in A's. For the scanner pages the comparison is
  with the scanner's current pages drawn with the live channel's values: every
  section title and anchor, paragraph, list item and notice.
- M9. With A in the tree, the eight tests above pass unedited and reading the
  same files, and `pnpm check`, `pnpm typecheck` and `pnpm test` exit 0.

## The queries

Written from the pages' content before anything is built; the right page
follows each.

1. `metamask` — Money.
2. `restaurant` — Common questions.
3. `tracking number` — Orders and fulfillment modes.
4. `refusal codes` — The product card.
5. `handler crashed` — What can go wrong.
6. `createClient` — The first test sale.
7. `change wallet two days` — Connecting to Agentify.
8. `several instances` — Orders and fulfillment modes.
9. `network fee` — Money.
10. `who settles a dispute` — Common questions.

Two more are asked of A alone, for the scanner section: `robots.txt` — the
scanner's identity; `coverage score` — the methodology.

## Predictions

- P1. A's script on a first visit, M1, is at most 100 KB on every page,
  the orders page included.
- P2. On the six pages without a diagram, A's M1 exceeds B's on the same page
  by at most 30 KB. On the orders page A's M1 is at most half of B's.
- P3. A's stylesheets, M2, are no larger than B's on any page.
- P4. A's HTML in brotli is at most two and a half times B's on every page,
  since a hydrated page carries its content a second time as data. A's first
  visit in total is at most 1.2 times B's on the six pages without a diagram,
  and at most half of B's on the orders page.
- P5. A's build, M4, takes no longer than B's and at most 60 s, and drawing
  the three diagrams takes at most 15 s of it.
- P6. All three diagrams are inline SVG in A's orders page, and the orders
  page requests no more script than the lightest page.
- P7. A's search hits at least nine of the ten queries and no fewer than B's;
  both scanner queries hit; A's index is at most 1.25 times B's, and the script
  A fetches on opening the search is no larger than B's.
- P8. M8 finds no difference on any of the nine pages.
- P9. M9 holds, and no file under `apps/docs/*.md` or `apps/docs/examples/` is
  edited.

## The decision rule

1. P8 and P9 decide the pipeline. If both hold, markdown-it is the pipeline of
   the migration. If either misses, the cause is found. A cause in the spike's
   own code is fixed, everything is measured once more, and this rule is
   applied to the second measurement. A miss that remains is a cause in
   markdown-it, and the pipeline is built a second time on remark and rehype
   and measured under P8 and P9; the one with fewer differences is chosen, and
   a tie goes to markdown-it.
2. P1 decides whether the documentation hydrates. If P1 holds, the pages
   hydrate as every other surface's do. If P1 misses, the cause is found; a
   cause in the spike's own code is fixed and measured again. A cause in the
   framework's weight sends the pages without React's scripts, as the
   dashboard sends a page whose route says `script: false`, with the search
   loaded by a script of its own on first use; that variant is measured under
   P1 to P7 and becomes the migration's if it holds P1, P6 and P7.
3. P6 and P7 are conditions of the migration, because a reader must lose
   neither a diagram nor the way to find a page. A miss of either that
   remains after the spike's own code is fixed must be fixed before the
   migration's pull request is opened, and the results say what fixing it
   takes.
4. P2 to P5 are not conditions. Each miss is written into the results with its
   cause, and the migration's pull request names it as a cost or as something
   the reader loses.
5. B is not chosen by this rule. It is the measure of what the move gives and
   takes, and the owner's decision to move stands whatever it shows.

## Amendment, before any measurement

Added on 2026-10-14, after the registration above was committed and before
anything was built far enough to measure or was measured. It carries the
product owner's own view of the two documentations, relayed the same day: the
VitePress portal works fast and well, but its header is odd, with the logo not
where the rest of the site has it, while the scanner's documentation has the
look to keep. The target is therefore the portal's speed with the scanner's
look. The registration above stands; this section adds to it.

Candidate A changes in one respect. Its pages are drawn in the scanner's
editorial layout, the type, the contents column, the article column and the
notice box that `apps/web/components/editorial-page.tsx` and its stylesheet
draw `/methodology` with, under the shared site header, so the logo stands
where it stands on every other page. The contents column takes the place of
VitePress's sidebar and outline together: it lists the documentation's pages in
their groups, with the current page's sections under its name. The warning
container is drawn as the editorial notice. A table, a code block and a
diagram, which the scanner's pages do not have, are drawn in the same type and
palette. To keep moving between pages as quick as VitePress keeps it, A fetches
the data of every page its contents column links to once the link is on the
screen, as VitePress fetches a linked page's script, and its links inside the
text are followed without a page load, as VitePress follows them.

Two measurements are added, taken in Chromium behind 200 ms added to every
request by the browser's network emulation, with no slowdown of the processor,
each the median of five runs.

- M10. Moving between two pages: the time from a click on a link in the
  sidebar, or in A's contents column, to the destination page's heading being
  in the document with a frame painted after it. Two moves are timed, from
  Connecting to Agentify to The first test sale and from Money to Orders and
  fulfillment modes, each once after the pointer has rested on the link for
  300 ms and once with the click at once, the page having been open for two
  seconds before either.
- M11. The first visit: the largest contentful paint of each of the seven
  pages loaded with an empty cache.

Two predictions are added.

- P10. In each of the four timings of M10, A's time is at most B's plus 50 ms.
- P11. On every page, A's M11 is at most B's plus 100 ms.

The rule gains one sentence. P10 and P11 are conditions of the migration in
the sense of its third clause, beside P6 and P7, because moving to the one
stack must not make the documentation slower to read: a miss of either that
remains after the spike's own code is fixed must be fixed before the
migration's pull request is opened, and the results say what fixing it takes.

## Results

Taken on 2026-10-14 on the branch `spike/docs-one-stack`, which holds the
prototype and is deleted once these results reach `main`. The prototype is
`apps/docs-rr`; the measuring script, the stand-in for Caddy and the scanner's
two pages as the scanner draws them on the live channel are kept beside this
note in `47-one-docs-stack/`, and what the script printed is in
`47-one-docs-stack/results/`.

### What was built and how it was measured

A is React Router 8.4.0 in framework mode with `ssr: false`, every page and
the search index named in `prerender`, compiled by Vite 7.3.6 with React
19.2.7. One route draws every page from the Markdown its address names; its
loader runs only at build time and hands the page its HTML, its sections and
its neighbours. The build's last step lifts the prerendered files out of the
`docs/` directory React Router writes them under, so the directory Caddy's
block strips the prefix into answers `/docs/money` from `money/index.html`,
`/docs/money.data` from `money.data` and `/docs/assets/…` from `assets/`, with
the block's `try_files` as it stands. The Markdown pipeline is markdown-it
15.0.2 with markdown-it-container 4.0.0, Shiki 4.5.0 and, at build time only,
Mermaid 11.17.2 drawn by Playwright 1.61.1's Chromium with the site's face
loaded; the search is MiniSearch 7.2.0. The shared header needed one change,
the documentation added to `@agentify/ui`'s surfaces. The application is about
1,050 lines of TypeScript and 500 of stylesheet, where VitePress's config and
theme are 530 lines; the pipeline itself is about 360 of those lines.

Both sites were built for `/docs/` and served on this Mac by `serve.mjs`, which
answers as the `/docs` block of the Caddyfile does, fills the surface marker's
templates as the test channel does, compresses with gzip as Caddy's `encode`
would and sends `Last-Modified` and `ETag` and no `Cache-Control`, as Caddy's
file server does. Chromium is Playwright's. Sizes are each file compressed by
brotli at its highest quality; times are medians of five runs behind 200 ms
added to every request by Chromium's network emulation, with no slowdown of
the processor. Before the measurement the instrument was run once with one
sample of each figure, to find its own faults; that run's figures are not used.
Its sizes came within 0.1% of the measurement's, its moves within 7 ms and its
paints within 28 ms.

Every comparison carries a negative control, so that an instrument blind to
differences cannot pass. Comparing B's Money with A's Common questions the same
way the pages are compared finds 18 differences, the methodology's section
titles looked for on the scanner identity page find 7 missing, and a query no
page answers hits nothing on either site.

### The table

"First visit" is the HTML, the scripts and the stylesheets of a cold load in
brotli, the scripts counted as registered: every script the browser asked for
until the network rested. The largest paint is M11.

| Page | Script, A / B | Stylesheets, A / B | HTML, A / B | First visit, A / B | Largest paint, A / B |
| --- | --- | --- | --- | --- | --- |
| Connecting to Agentify | 90.9 / 246.1 KB | 4.7 / 18.0 KB | 6.0 / 5.3 KB | 101.5 / 269.5 KB | 440 / 440 ms |
| Money | 90.9 / 242.4 KB | 4.7 / 18.0 KB | 6.7 / 5.8 KB | 102.3 / 266.3 KB | 440 / 440 ms |
| Common questions | 90.9 / 242.9 KB | 4.7 / 18.0 KB | 6.1 / 5.3 KB | 101.6 / 266.2 KB | 440 / 452 ms |
| The first test sale | 90.9 / 234.9 KB | 4.7 / 18.0 KB | 16.7 / 13.3 KB | 112.3 / 266.2 KB | 444 / 452 ms |
| The product card | 90.9 / 234.0 KB | 4.7 / 18.0 KB | 18.5 / 14.3 KB | 114.0 / 266.3 KB | 448 / 460 ms |
| Orders and fulfillment modes | 90.9 / 616.8 KB | 4.7 / 18.0 KB | 28.0 / 16.6 KB | 123.5 / 651.4 KB | 448 / 472 ms |
| What can go wrong | 90.9 / 242.1 KB | 4.7 / 18.0 KB | 7.2 / 6.2 KB | 102.8 / 266.3 KB | 436 / 452 ms |
| About agentify-scanner | 90.9 KB / no page | 4.7 KB / no page | 4.2 KB / no page | 99.7 KB / no page | not measured |
| Methodology | 90.9 KB / no page | 4.7 KB / no page | 4.5 KB / no page | 100.0 KB / no page | not measured |

Moving between two pages, M10, from the click to the destination's heading on
screen:

| Move | A, after a rest | A, at once | B, after a rest | B, at once |
| --- | --- | --- | --- | --- |
| Connecting to Agentify to The first test sale | 44.3 ms | 41.9 ms | 57.0 ms | 56.1 ms |
| Money to Orders and fulfillment modes | 46.3 ms | 46.0 ms | 57.0 ms | 55.9 ms |

The clean build, M4, took a median of 2.1 s for A (5.2, 2.0 and 2.1 s) and
7.5 s for B (17.9, 7.5 and 5.8 s); drawing A's three diagrams took 1.0, 0.45
and 0.44 s of A's builds, and A built in 1.6 s with the diagrams already drawn.
All three `mermaid` fences are inline SVG in A's orders page, which asks for
0 KB of script beyond the lightest page, where B's asks for 382.8 KB more (M5).
The search, M6 and M7: A's index is 27.9 KB and opening its search fetches
5.9 KB of script, against B's 24.5 KB and 19.0 KB; A's index holds two more
pages than B's. Both sites put the right page in the first three results for
all ten queries, and for every query the first three results of the two sites
are the same addresses in the same order. Both scanner queries hit on A. M8
found no difference on any of the nine pages: on the seven merchant pages the
headings with their levels, texts and anchors, the 9 tables, the 22 code
blocks, the 6 included examples, the 3 diagrams and the 199 links of B are all
in A, and every paragraph and list item of each page is the same text in both,
which was compared though not registered; on the scanner's two pages every
title, anchor, paragraph, list item and notice of the scanner's own pages is
there.

On both channels' templates A's notice was right after a move as well as on
load: the test channel's words once, the live channel's empty marker, and no
error in the page.

### The predictions

P1 holds: 90.9 KB on every page against 100 KB. P2 holds: on the six pages
without a diagram A's script is 143 to 155 KB under B's rather than at most
30 KB over it, and on the orders page it is 15% of B's. P3 holds: 4.7 KB
against 18.0 KB. P4 holds: A's HTML is 1.13 to 1.29 times B's on the six pages
and 1.69 times on the orders page, against 2.5; A's first visit is 0.38 to 0.43
of B's on the six pages and 0.19 on the orders page. P5 holds: 2.1 s against
B's 7.5 s and the 60 s limit, of which the diagrams took at most 1.0 s against
15 s. P6 holds. P7 holds: ten of ten queries on both, the two scanner queries,
an index 1.14 times B's against 1.25, and 5.9 KB of search script against
19.0 KB. P8 holds. P9 holds: the eight tests pass, 122 tests in 8 files, with
nothing under `apps/docs` edited; with the prototype in the tree `pnpm check`
exits 0 with no diagnostic in the prototype's files, `pnpm typecheck` exits 0,
`pnpm test` exits 0 with 4,108 tests in 264 files and the operational tests,
and `pnpm deadcode` and `./scripts/check-decisions.sh` pass. P10 holds: A is
quicker than B in all four timings, by 10 to 14 ms. P11 holds: A's largest
paint is the same as B's or up to 24 ms earlier on every page.

### The rule's outcome

P8 and P9 hold, so markdown-it is the pipeline of the migration, and remark
and rehype are not built. P1 holds, so the documentation hydrates as every
other surface does. P6, P7, P10 and P11, the conditions of the migration, hold.
P2 to P5 hold, so the rule leaves no cost of theirs for the migration to name.
B is not chosen.

### What was found while building

Two defects of the prototype's own code were found in Chromium while it was
built, before the instrument existed, and fixed before anything was measured;
both are traps the migration inherits.

React writes an element's raw HTML again whenever it is handed a new object
for it, whatever the string inside. The notice that names the channel is raw
HTML that Caddy fills at request time, so the first move to another page
replaced the filled notice with the built one, whose templates are inert in a
browser, and the page showed the test channel's words and the sandbox's "every
payment it accepts is pretend" together. The prototype reads the notice back
from the page before React draws over it and hands React one object for the
life of the page. A test must hold this, in a browser, through Caddy's
templates, after a move.

React Router prefetches a page's data under an address with `?_routes=` when
any route on the page opts out of revalidation, while a prerendered site's
navigation asks for the address without it, so every prefetch was fetched and
thrown away and every click waited a whole round trip. The prototype's root
route gives up its `shouldRevalidate`, which costs nothing because a
prerendered page's data file carries every route's data anyway. A test must
hold that a click on a prefetched link asks the network for nothing.

On the test channel the notice cannot stand above the header, where VitePress
places it: the header's `backdrop-filter` makes it the containing block of the
fixed skip link, which then shows its lowest 10 px at the top of the window,
over the notice. The
prototype places the notice under the header, as the dashboard does.

### What the figures do not say

B's script is not VitePress's own weight. Of its 194 KB on an ordinary page,
140 KB is VitePress's `app` chunk, which the mermaid plugin fills with the
diagram library's core on every page, and VitePress's framework and theme are
54 KB together. A VitePress site that drew its diagrams at build time would, I
estimate without having measured it, send 60 to 70 KB of script to A's 91 KB,
so the difference in the table is the diagrams being drawn at build, which
either stack can do, and not React Router being lighter: React and React Router
are 86 KB of A's 91. The same probably holds for the build time, a share of
which in B is bundling the diagram library; that share was not measured.

The times are a local server over plain HTTP/1.1 with no TLS, and the 200 ms is
added to each request rather than to each connection, so a real first visit
costs more round trips than this, on both alike. Both move in about 50 ms
because both had fetched the destination before the click: A fetches the data
of every page its contents column shows, 36 to 66 KB on a first visit, and B
the scripts of the pages its sidebar shows, 38 to 52 KB, counted in its
script above. A reader on a metered connection pays that on both. A's HTML is
larger as built, 321 KB for the orders page against 72 KB, because a hydrated
page carries its content a second time as the data it hydrates with and
because the inline diagrams are 26 to 31 KB each; compressed, the difference is
the 11 KB in the table. Brotli was the registered unit; Caddy's portal block
sends zstd or gzip today, and serving the precompressed brotli files is a
setting of the block, not of the stack.

The image build was not tried: Docker is not run on this machine. Playwright
does not support Alpine, the image the portal stage builds on today, so the
diagrams cannot be drawn there as they were drawn here.

### What a reader loses

Most of what VitePress gives a reader is in A: navigation without a reload,
links prefetched before the click, the search with the same ranking, the
copy button and language label on code, the heading anchors, the previous and
next page, the page for a missing address, and scroll restored on Back. These
are not:

- The outline does not mark the section being read as the page scrolls; A
  lists the current page's sections, as VitePress's outline does, but statically.
- The search shows the headings a result sits under, without VitePress's
  detailed view with an excerpt and the matched words marked, and it does not
  keep the query when the page is reloaded.
- On a phone, VitePress's sidebar slides in from a button and its outline is a
  menu in a bar of its own; A folds the contents into one row above the page,
  and there is no "return to top".
- `/docs/money.html` answers today, because VitePress writes `money.html`, and
  does not in A, which writes `money/index.html`. Nothing in the repository
  links to such an address; a link outside it would break.

Moving the scanner's two pages takes away more than moving the merchant pages
does, because today they are pages of the scanner:

- The scanner answers `/methodology` and `/scanner` as Markdown to a client
  that asks for it, and lists them in `llms.txt`; static HTML under `/docs`
  answers nothing as Markdown unless the build writes a Markdown copy and
  Caddy chooses it by the `Accept` header.
- Their text is drawn from the scanner's environment: the site's address in
  both user agents, the operator's name, the abuse address and the notice that
  the legal identity is not yet published. A built page carries the live
  channel's values on every channel, so the test channel's page names the live
  site's user agent, and confirming the legal identity becomes an edit to the
  Markdown rather than a setting.
- The methodology's eighteen checks are a list written out in Markdown, where
  the scanner draws them from its check definitions.
- The scanner's editorial pages carry the site's structured data, a canonical
  address and their own description, and the consented analytics record a view
  of them; the prototype's pages carry a title and the documentation's
  description only.

### What the migration's pull request must contain

1. VitePress replaced by the React Router application in `apps/docs` itself,
   the Markdown and the examples staying where the eight tests read them, and
   `vitepress`, its mermaid plugin and Vue removed with the theme and the
   config. The two tests that hold the theme's palette and the build hook's
   wording to their originals are deleted with the copies they guard, and
   `scripts/check-portal-render.mjs` reads the new build and finds the
   notice where the new layout puts it.
2. The editorial layout's styles moved where both the scanner's remaining
   editorial pages, privacy and terms, and the documentation draw from them,
   rather than the copy the prototype keeps.
3. A decision on the diagrams in the image. Either the portal stage moves to an
   image Chromium runs on, or the drawn SVGs are kept in the repository under
   the hash of their source, the build reads them and fails on a fence with no
   drawing, `pnpm test` checks that every fence has one, and a command draws a
   changed diagram. The second keeps the image as small as it is and the build
   free of a browser, and is what I would choose.
4. The scanner's pages moved: `/scanner` and `/methodology` answered by a
   redirect to `/docs/scanner` and `/docs/scanner/methodology` so the
   address in both user agents keeps answering; the shared header's Scanner
   and Methodology links, the scanner's footer, its sitemap, `llms.txt`, its
   structured data and its tests pointed at the new addresses; and the
   scanner's routes and text for the two pages deleted.
5. A test holding the methodology's list to the scanner's check definitions,
   and one holding the identity page's user agents and limits to the scanner's
   own values, since the Markdown is now a copy of what the code says; and a
   choice between the live channel's values on every channel and Caddy's
   templates for them.
6. The Caddy block given a text type for `.data` files, since Caddy's `encode`
   compresses only types it knows as text and the orders page's data is 146 KB
   as built (what type Caddy's file server gives `.data` today I don't know);
   a year's immutable cache for `/docs/assets/`, which carry a content hash and
   are sent today without a lifetime; and, if wanted, the precompressed brotli
   files.
7. The speed budget of `@agentify/ui/budget` applied to the documentation, at
   the dashboard's 100 KB.
8. A browser test through the Caddy templates that the notice shows one
   channel's words after a move, that a click on a prefetched link asks the
   network for nothing, and that the search finds a page.

### Risks

The two traps above are the framework's behaviour rather than the
prototype's, and both fail silently: a page that shows every channel's notice
after a move, and prefetches that cost bandwidth and save no time. They are
held only by browser tests.

The documentation's correctness now depends on one more copy step done by
code the repository owns: about 360 lines that make markdown-it mean what
VitePress means. Parity was measured on today's pages; a VitePress feature a
writer reaches for later, such as a code group, line highlighting or a custom
container kind, does nothing until it is written, and the writers' guide in
`apps/docs/WRITING.md` should say which syntax the pipeline understands.

The scanner's pages leave the process that knows the scanner's facts, and
until the tests of item 5 exist they can drift from what the scanner does.

## The migration, measured again

Taken on 2026-10-14 on the migration's branch, `agent/docs-one-stack`, with
the instrument above pointed at the migrated `apps/docs` and at the same
VitePress build as B, served the same way except that A is served by the
browser tests' stand-in for Caddy's block, `apps/docs/testing/edge.ts`, which
fills the site's values as well as the notice. The instrument's own selectors
were changed to the migrated layout's; nothing else in it was. What it printed
is `47-one-docs-stack/results/migration-browser.json`, with B's directory
written as the address it was built at and the servers' ports left out.

Every page loads 92.4 KB of script on a first visit against B's 234 to
617 KB, and 4.8 KB of stylesheet against 18.0 KB; the first visit in total is
102 to 126 KB against 266 to 651 KB. The pages' HTML in brotli is 4.8 to
28.3 KB against B's 5.3 to 16.6 KB. Moving between two pages took 52.6 to
71.0 ms against B's 55.3 to 65.9 ms, the largest difference 15.6 ms; the
largest paint of a cold load was 444 to 460 ms against 448 to 468 ms. All
three diagrams are inline, the orders page asks for no script beyond the
lightest, and the notice is the channel's own on load and after a move on
both channels.

The search hits every registered query and both of the scanner's, with the
same first three results as B for every query. Its index is 67.2 KB against
B's 24.5 KB, where the prototype's was 27.9 KB: the index now keeps each
section's text, so that a result can show the words it was found by with the
match marked, which VitePress does by fetching the result's page. Opening the
search for the first time therefore fetches 73.4 KB against B's 43.5 KB,
while every page carries 142 KB or more less script than B's.

A first measurement on the branch found the largest paint 180 to 200 ms
later than B's: the faces were linked as a second stylesheet from the shared
origin, and over HTTP/1.1, where a browser opens six connections to a host,
that stylesheet waited behind the page's scripts for a connection. The faces
are now written into the documentation's own stylesheet, and the paints above
are the second measurement's. Over HTTP/2, which the deployed channels speak,
the six connections do not apply.
