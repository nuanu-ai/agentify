# Public page Lighthouse measurements

> Historical, 2026-10-15. Lighthouse scores of the public pages on that day; the pages have changed since.

## Method fixed before measurement

The candidate starts at `1c8ab4e8`. The target is the public scanner pages
(`/`, `/store`, `/local`, `/agentic-shop`) and documentation (`/docs/`,
`/docs/scanner/methodology`). Private pages remain outside search.

Use Lighthouse 13.5.0 with an isolated Chrome profile, empty browser storage,
and its default simulated mobile throttling or desktop preset. Run audits
sequentially. Record all four categories and the raw loading metrics. The
published site provides deployment context; compare code changes on local
production builds with the same serving path and configuration.

First audit each representative page in both device modes. Repeat the
before/after measurements three times for pages affected by an optimization
and report medians and ranges, including regressions. Raw reports stay outside
the repository; this note records the commands and compact results.

The prediction is that eliminating redundant font downloads and shortening
critical resource discovery can reduce transfer and loading delay without
changing page content or behavior. An optimization is accepted only when the
waterfall or browser behavior verifies its mechanism and repeated measurements
show improvement or no material regression. Accessibility and SEO fixes must
repair an actual user or crawler problem. A policy, consent flow, or functioning
feature is not removed to improve a score.

Lighthouse results are laboratory measurements. They do not establish field
Core Web Vitals, complete accessibility, Google indexing, or ranking changes.

## Protocol control fixed before the additional measurement

The first paired series uses the repository's browser-test edge over HTTP/1.1.
It exposes a repeatable selling-page regression: mobile LCP rises from about
2.78 to 3.00 seconds with the font/image priority combination. The published
site serves HTTP/2 and compressed HTML; the local scanner test edge does not.
These differences preclude comparing its scores directly with the published
site's scores.

Run a second paired control over local HTTPS/HTTP/2 with gzip HTML and the
same built assets. Use the saved original builds and candidate builds behind
identical proxy code. The certificate is local and self-signed, ignored only
for this loopback measurement; it is no evidence about public TLS. Confirm
the negotiated protocol in each report. Repeat all six pages three times on
mobile and desktop, with the same Lighthouse presets as the first series.
This protocol matches the deployment more closely, so it decides which
priority changes to keep. Reject a repeatable LCP regression above 100 ms or
any category-score regression, and remove or adjust the responsible hint
before the final comparison. Keep the original HTTP/1.1 results visible.

The first HTTP/2 selling-page candidate raises mobile LCP from 1.81 to 2.11
seconds even though Performance rises from 98 to 99. It fails that rule.
Remove the image's high-priority hint first, keeping the font changes fixed,
and repeat the selling page before measuring the remaining candidate pages.
The font-only experiment is the `final-h2` series; `after-h2` remains the
rejected priority experiment. Its selling page passes, but the three text
landings gain about 150 ms of simulated LCP despite earlier first paint and
zero layout shift. Move the web font preload from the common root to the
selling route. Repeat those four web pages as `accepted-h2`; the documentation
build is unchanged and retains its `final-h2` results. This keeps the scope
where the hints pass the original decision rule.

## Accepted results, 15 October 2026

The baseline is `1c8ab4e8`; the accepted source is `ca3055d3`. Measurements
use Chrome 155 and Node 26.7 on the same macOS machine. Mobile uses Lighthouse's
simulated 4G and fourfold CPU slowdown; desktop uses its desktop preset.
Each cell below is a median of three cold visits over HTTP/2. Every
Performance score in that paired comparison has an identical minimum and
maximum across its three runs. [The CSV](49-lighthouse-results.csv) records the score and LCP ranges,
first paint, layout shift, blocking time, speed index and font bytes.

| Page | Mobile Performance | Mobile LCP, ms | Desktop Performance | Desktop LCP, ms |
| --- | --- | --- | --- | --- |
| / | 99 → 99 | 1663 → 1667 | 100 → 100 | 372 → 375 |
| /store | 99 → 99 | 1661 → 1673 | 100 → 100 | 370 → 375 |
| /local | 99 → 99 | 1659 → 1659 | 100 → 100 | 375 → 375 |
| /agentic-shop | 98 → 99 | 1807 → 1806 | 100 → 100 | 407 → 407 |
| /docs/ | 98 → 100 | 1803 → 1652 | 100 → 100 | 403 → 363 |
| /docs/scanner/methodology | 98 → 100 | 1802 → 1652 | 100 → 100 | 402 → 362 |

Accessibility, Best Practices and SEO are 100 in every baseline and accepted
run. Total Blocking Time is zero. LCP, the largest contentful paint, has no
accepted regression above the predefined 100 ms tolerance; the largest median
increase is 12 ms. These load tests do not measure Interaction to Next Paint
over a real user's session.

The documentation downloads 66,864 bytes of fonts instead of 91,208: one
24,344-byte regular Latin face is no longer downloaded. The existing variable
face supplies both regular and semibold text. The static file remains on disk
because the diagram generator uses it. Font preloads use anonymous CORS and
the exact URL the stylesheet uses, so discovery does not create another copy.

The final HTTP/1.1 selling-page control also passes: mobile Performance
92 → 93, LCP 2,778 → 2,706 ms; desktop remains 100, LCP 624 → 663 ms.
The initial HTTP/1.1 documentation trial is 96 → 98, LCP 2,252 → 2,103 ms.
These scores belong to that serving path, not to the deployed site or the
HTTP/2 table. Initial probes with NO_FCP, incorrectly applied device presets,
or overlapping audits are excluded; accepted reports validate the device,
negotiated protocol and absence of runtime errors.

## Behavior and review

The original built pages supply the negative product variant: the discovery
assertion sees `css`, and the documentation assertion sees two font requests.
The new checks reject it. Blocking WOFF2 only in an isolated browser context
also makes the real-glyph check fail; restoring access passes. This control
distinguishes the intended custom font from a system fallback.

Separate browser acceptance uses the real built pages, including
`/docs/orders`, at 390 and 1280 pixels. Actual regular and semibold glyphs use
Schibsted Grotesk. Heading boxes and all 47 diagram-label boxes match their
original dimensions; the captures have no horizontal overflow or page errors.
Independent logic and UX reviews find no actionable issue. Saved captures do
not establish a complete keyboard or screen-reader audit.

Web/docs builds, workspace type checking, both existing script budgets and
Biome pass locally. The added behavior checks also run in the full CI browser
suite. Local direct test launches encounter sandbox IPC restrictions and
permission-review timeouts, so full suite evidence comes from the PR's CI
checks rather than from those interrupted local processes. CI and image
publication are checked against the final PR head before handover.

## Compatibility with the current main branch

The source at `5dc860df` integrates `main` at `6da6ce06`, including PR #142.
There are no merge conflicts. Its accessibility changes preserve both font
preloads and the shared variable face. They do change the landing hero's DOM
and grid container, and the documentation's initially loaded search and
clipboard code, so the earlier measurements alone do not validate this tree.

The separate `integrated-h2` series repeats all six pages three times on both
devices with the same protocol and presets. Median Performance stays at 99
for the four mobile web pages, 100 for both mobile documentation pages, and
100 for all desktop pages. The methodology page's mobile range is 99–100;
all other Performance ranges are single values. Accessibility, Best Practices
and SEO remain 100 in all 36 runs. The largest median LCP increase against
the accepted candidate is 3 ms. The CSV marks these rows as `integrated`;
this compatibility repeat is not an isolated measurement of PR #142's effect.

Both production builds and first-visit script budgets pass after integration.
The font requests, actual glyphs and page geometry are checked again against
the integrated builds; the full browser and test suites run on the PR head.

## Repeating the measurements

The raw JSON reports and temporary serving helpers are under
`/private/tmp/agentify-lighthouse-20261015` on the measurement host. The
`before-h2` series is the baseline; `accepted-h2` supplies the final web pages
and `final-h2` the unchanged documentation build. Earlier series are diagnostic
trials and are not mixed into the accepted medians.

The HTTP/2 stand puts the repository's browser-test edge and built scanner
behind a loopback Node HTTP/2 proxy. It preserves precompressed assets, adds
gzip to uncompressed HTML and fills each build's own public origin. This
approximates Caddy's delivery; it is not a deployed Caddy measurement. A fresh
Chrome profile is launched for every audit. The temporary TLS certificate is
ignored only for loopback.

For a public deployment, the corresponding Lighthouse command is:

```sh
npx --yes lighthouse@13.5.0 https://agentify.ad/docs/ \
  --chrome-flags='--headless --disable-extensions' \
  --only-categories=performance,accessibility,best-practices,seo \
  --output=json --output-path=lighthouse-docs-mobile.json
```

Add `--preset=desktop` for the desktop preset. Repeat three times in the same
environment and compare medians, ranges and individual metrics. Public
measurements after release and field Core Web Vitals remain unmeasured here;
the table is evidence about these builds and test conditions, not about
indexing or search positions.
