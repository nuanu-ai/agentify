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
depends on it names the limit. A sitemap served as a gzip file is unpacked, and
the 5 MiB limit applies to what it unpacks to. A gzip sitemap that cannot be
unpacked is reported as broken, since an agent cannot read it either. A
response that sends more than twice its limit and 64 KiB without decoding to
the limit is stopped, and the check that needed it is unavailable. The scan
reads at most three sitemap files, an index and the sitemaps it lists
included, and a listed sitemap whose address redirected counts as read at the
address that was listed.

What was read proves what it contains. A heading, a link or a sitemap entry
found before the limit counts. A discovery document longer than its limit is
too large, since its size is known, and a page longer than 2 MiB fails the
page-weight check for the same reason. An llms.txt longer than its limit
passes when a heading and a link were read before the limit and is too large
otherwise. A robots.txt longer than its limit is partial, since crawlers need
read only its first 500 KiB. A sitemap may be larger than 5 MiB, so it is
judged by the entries read, and one cut before any entry is not judged. A check
that would have to conclude from a cut page that something is missing is
unavailable.

A 404 or 410 says a document is not there, and so does a web page where a
document belongs: an answer that opens with a page's doctype or `<html>` tag
after any white space, comments and XML prolog. An empty answer is no document
where a JSON document belongs. An empty llms.txt is malformed, an empty sitemap
is not a sitemap, and an empty robots.txt passes, since the robots standard
reads it as having no rules. Any other 4xx, such as 401 or 403, refuses the
document to an agent as it did to the scanner, so the scan takes it as absent
and says so: the check fails, or does not apply to the optional llms.txt and
A2A card, and the result asks you to allow the document or answer 404. An MCP
server card whose address asks for a sign-in fails in words of its own, since
an agent has to read the card before it can sign in. No answer at all, a
timeout (408), a rate limit (429), a refusal of the scanner's request headers
(431), an answer that depends on where the scanner asks from (451) or a server
error says nothing about the document, so the check is unavailable and its
evidence gives the status. A JSON document that is there but is not a valid
JSON object, whatever it opens with, is reported as unparseable.

When a check reads several documents, a defect proven by what was read
stands, while a pass or a verdict that nothing usable exists needs every
document read. One complete MCP server card passes whatever the other location
answered. A sitemap index whose listed sitemaps did not all answer is not
judged as a whole unless a defect was proven. The evidence names each sitemap
that did not answer and, while the scan has read fewer than three files, each
that the index lists on another site, which the scan does not read.

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
