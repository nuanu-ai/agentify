# 0031. The browser observer answers one versioned contract and stays on the target's site

Date: 2026-09-28
Status: accepted (Dmitry, 2026-09-28)

## Context

The scanner can also open up to three public pages of a site in a real
browser, a private Apify Actor that Apify starts on request off our host.
The worker reaches it with one message each way between two builds deployed
apart, a wire contract, and the pages it opens are the site's choice, a
security boundary. Neither was written down, and the output grew an
18-field `signals` object no reader used, whose limits would fail a whole
run for a page past 1,000 requests (a constructed page of 1,200 images
showed it) and for the observer's own `cookie_wall`. Browser observation is
off in production.

## Decision

The contract is `browser-public-v2.0.0`, defined in
`packages/scanner-contracts/src/browser-observation.ts` and repeated in the
Actor's Apify input schema and build tag, which a test holds to it. The
input names the operation; the target, by canonical URL, registrable domain
(`example.co.uk`, or a tenant's name on a shared platform domain such as
`shop.myshopify.com`) and segment; at most two more pages; a fixed policy
(GET and HEAD only, no proxy, robots.txt respected, search purpose); and
limits (3 pages, 80 requests a page, 8 MiB, 12 s a page, 45 s a run).
Besides its version, operation and build, the output carries the status,
the pages assessed, one finding for each of the fourteen observations and
the run's total time. Both sides validate strictly. The worker names the
build it expects by number, and refuses an answer in another version as
`browser_contract_version_mismatch` before reading its shape, and one from
another build as `actor_build_mismatch`. A field enters the output only when
something reads it, and the findings never enter the score.

Inside the Actor every request is GET or HEAD, over http or https on the
default port, without credentials in the URL, to a host that resolves only
to public addresses, pinned for the connection. A navigation stays on the
target's registrable domain, and a redirect never falls from https to http.
A fixed set of request headers leaves, none of them a cookie, and a
response's cookies are dropped. A main-frame navigation robots.txt
disallows for the observer is not made, and requests, bytes and time count
against the limits.

## Consequences

One file says what crosses, and a build out of step fails aloud. Deleting
`signals` removed two limits that failed runs and a value validated three
times for no reader; the findings carry what a reader shows. Observations
made under the previous version keep their rows but no report shows them,
since the routes read this version only; migration 0022 closes those that
never reached the Actor.

The adversarial review of 2026-09-28 found the boundary incomplete: Chromium
fetches an `http://` target itself when its own https upgrade fails, outside
the Actor's request route; robots.txt is consulted for the main frame only;
a navigation a script or a meta refresh makes is checked for its domain,
not for a fall to http; and a popup crashes the run. These are defects
against this decision, not exceptions to it.

Rejected: keeping `signals` with looser limits, since every field is surface
someone must learn and no reader justified one; and reading the output
leniently, which would let a build out of step pass half understood.
