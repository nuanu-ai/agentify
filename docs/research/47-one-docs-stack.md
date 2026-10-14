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
