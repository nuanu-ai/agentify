# How the agent-readiness scan works

We diagnose public, machine-readable website signals. The result is a versioned
technical baseline — never a certification, search ranking, or promise of model
behavior.

## What we check {#what}

The scan runs 18 checks across discovery, structured content, agent-like HTTP
access, signals for your kind of business, and experimental surfaces.

- `#1` robots.txt availability
- `#2` AI crawler policy
- `#3` Content-Signal policy
- `#4` Sitemap
- `#5` Structured data availability
- `#6` Business-specific structured data
- `#7` Markdown content negotiation
- `#8` llms.txt
- `#9` MCP server card
- `#10` UCP profile
- `#11` OAuth discovery metadata
- `#12` Server-rendered content
- `#13` Agent user-agent access
- `#14` Page weight and response time
- `#15` Product feed discovery
- `#16` Platform fingerprint
- `#17` A2A agent card
- `#18` Language alternatives

## How scoring works {#scoring}

The backend excludes not-applicable checks, removes unavailable weight from the
assessed denominator, and stores the resulting score together with coverage and
rubric version.

::: note
Coverage below 70% produces an incomplete, provisional result. Coverage below
30% produces no public score, and neither does a home page the site answers with
a bot challenge or a refusal, whatever the coverage: a 401, 403 or 429 status, a
known challenge vendor's page, or an error page saying access is denied.
Benchmarks stay hidden until at least thirty scans of the same segment have
finished with coverage of 70% or more. Coverage is shown as the whole percent
it has reached, rounded down, so 69.8% reads 69% and only a scan that assessed
everything reads 100%.
:::

- Invisible: 0–24
- Readable: 25–49
- Callable-ready: 50–69
- Ahead of the market: 70–100

## What each result means {#states}

- Pass — the expected public signal was verified.
- Partial — a signal is present but incomplete.
- Fail — an accessible surface confirmed a negative fact.
- Unavailable — we could not reach a verdict; this is not a failure.
- Not applicable — the check does not apply to this site or segment.

A result other than a pass names one cause, and its evidence lists the fields,
sitemaps or codes involved.

## What the scan could not read {#unread}

The scanner reads each response up to a limit of its own: 512 KiB for
robots.txt and llms.txt, 1 MiB for a discovery document such as an MCP server
card, a UCP profile, an A2A agent card or OAuth metadata, 2 MiB for a page, and
5 MiB for a sitemap. A longer response is cut at its limit, and a result that
depends on it names the limit.

What was read proves what it contains and says nothing about the rest. A
heading, a link or a sitemap entry found before the limit counts. A check that
would have to conclude that something is missing from a response that was cut
is unavailable. A page longer than 2 MiB still fails the page-weight check,
since its size is known.

A 404 or 410 says a document is not there, and so does a web page served where
a text or JSON document belongs. Any other answer, such as no answer at all, a
server error, a refusal or a rate limit, says nothing about the document, so the
check is unavailable and its evidence gives the status. robots.txt follows its
own standard, under which a crawler treats a refused robots.txt as having no
rules at all, and the scan reports it as refused. A document that is there but
cannot be parsed is reported as unparseable.

A verdict that nothing usable exists needs every location the check reads to
have answered. A sitemap that a sitemap index lists and that did not answer is
named in the evidence and does not lower the score.

## Non-scoring browser observations {#browser-observation}

When enabled, the separate `browser-public-v2.0.0` layer passively renders
public pages to observe JavaScript-only content, accessibility/form semantics,
runtime/network health, metadata consistency, declared agent/API surfaces, and
rendering cost. These findings are shown separately and never change the
18-check `gtm-v1.0.0` score.

## What the scan cannot tell you {#limits}

A regional HTTP measurement can observe latency, output, metadata, and access at
scan time. It does not prove worldwide availability, crawler identity
enforcement, live stock or appointment correctness, or how any particular model
will answer.

::: note
“Callable-ready” describes public discovery metadata. It does not mean that
Agentify invoked a tool, authenticated a user, completed a booking, or verified
checkout.
:::

## Checked, observed, and owner-only {#coverage-boundary}

- **Checked:** public crawler policy, sitemap, substantive initial HTML, JSON-LD
  structure, and the optional llms.txt surface.
- **Observed only:** public protocol declarations, passive browser structure,
  form semantics, and a bounded sample of visible-versus-structured facts.
- **Requires verified ownership:** authentication, tool calls, forms, booking,
  checkout, payments, rate-limit testing, idempotency, receipts, internal logs,
  SLOs, and kill switches.

## What we do not do {#not-do}

We do not log in, submit forms, click actions, bypass robots or access controls,
scan non-standard ports, perform vulnerability probing, make bookings, execute
checkout, or change the target site. The optional passive browser layer executes
only the public page JavaScript needed to render it and blocks mutating
requests.
