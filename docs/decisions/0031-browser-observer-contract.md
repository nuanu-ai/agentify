# 0031. The browser observer answers one versioned contract and stays on the target's site

Date: 2026-09-28
Status: accepted (Dmitry, 2026-09-28)

## Context

Beside its HTTP checks, the scanner can open up to three public pages of a
scanned site in a real browser and report what the rendered pages show. The
browser runs as a private Apify Actor, a container Apify starts on request,
off our host. The scanner worker reaches it with one message each way, an
input and an output, between two builds deployed separately: a wire
contract. The pages it opens are the site's choice, so what the Actor may
reach is a security boundary. Neither was written down, and the output grew
an 18-field `signals` object that no reader used while its own limits failed
real runs: a page with 1,200 images, and the observer's own `cookie_wall`.
Browser observation is off in production.

## Decision

The contract is `browser-public-v2.0.0`, defined once in
`packages/scanner-contracts/src/browser-observation.ts`. The input names the
operation, the target (its canonical URL, its registrable domain, the name a
registrar sells such as `example.co.uk`, and its segment), at most two more
pages, a fixed policy (GET and HEAD only, no proxy, robots.txt respected,
search purpose) and limits (3 pages, 80 requests a page, 8 MiB, 12 s a page,
45 s a run). The output carries the status, the pages assessed, one finding
for each of the fourteen observations, and timings; nothing else. Both sides
validate strictly against that schema. The version is compared exactly, and
the worker names the Actor build it expects: an answer in another version or
from another build is a failed observation with that reason, never read by a
looser rule. A field enters the output only when something reads it. The
findings never enter the score.

Inside the Actor every request is GET or HEAD, over http or https on the
default port, with no credentials in the URL, to a host that resolves only
to public addresses, pinned for the connection. A navigation stays on the
target's registrable domain and never falls from https to http. Only a fixed
set of request headers leaves, none of them a cookie, and a response's
cookies are dropped. A main-frame navigation that robots.txt disallows for
the observer's user agent is not made, and requests, bytes and time count
against the limits.

## Consequences

One file says what crosses between the worker and the Actor, and a build out
of step with the worker fails aloud. Deleting `signals` removed the two
limits that failed runs and a value validated three times for no reader;
the findings already carry what a reader shows.

The adversarial review of 2026-09-28 found the boundary above incomplete:
Chromium fetches an `http://` target itself when its own upgrade to https
fails, outside the Actor's request route; robots.txt is consulted for the
main frame only, not for frames, popups or fetches; and a popup crashes the
run. These are defects against this decision, not exceptions to it.

Rejected: keeping `signals` with looser limits, since every field is surface
someone must learn and no reader justified one; and reading the output
leniently, ignoring unknown fields, which would let a build out of step pass
half understood.
