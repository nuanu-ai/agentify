# About agentify-scanner

What our requests look like to your site, and how to stop them.

## Identity and contact {#identity}

Scanner user agent: `agentify-scanner/1.0 (+{{origin}}/scanner)`

In robots.txt the scanner answers to the token `agentify-scanner`. Letter case
and a version after it do not matter, and a group that names only part of the
token, such as `agentify`, is not read as addressed to the scanner.

One check asks for your page twice more with the tokens ChatGPT and Claude
agents send, followed by the scanner's own name, for example `ChatGPT-User/1.0
(compatible; agentify-scanner/1.0; +{{origin}}/scanner)`, to see
whether your site answers AI agents differently. It never presents itself as
OpenAI or Anthropic without its own name.

Operator: {{operator}}. Abuse and opt-out contact:
[{{abuse-email}}](mailto:{{abuse-email}}).

:::: unless identity-confirmed
::: note
The production domain is active. The final legal identity is not published yet.
:::
::::

## What the HTTP scanner does {#behavior}

- GET and HEAD only; no JavaScript, cookies, credentials, forms, or browser
  session.
- Public HTTP(S) on ports 80 and 443 only.
- At most 5 redirects, revalidated at every hop.
- At most 18 outbound requests per scan and 2 concurrent requests per origin.
- Individual fetch timeout at 8 seconds; global result target within 60 seconds.

## Optional passive browser observation {#browser-observation}

A separate non-scoring layer may render up to three public same-site pages
through a private Apify Actor. Its user agent is `agentify-browser-observer/1.0
(+https://agentify.ad/scanner)`, and in robots.txt it answers to the token
`agentify-browser-observer`. Provider, budget, or challenge failures never
reduce the score.

- GET and HEAD only; public ports 80 and 443 only.
- No clicks, form entry/submission, login, checkout, CAPTCHA solving, proxy
  rotation, or access-control bypass.
- Fresh browser context for every run; downloads, popups, permissions, service
  workers, WebSockets, and mutating requests are blocked.
- We retain finding codes and the sanitized aggregate counts they rest on, not
  raw HTML, screenshots, cookies, storage state, console text, full
  accessibility trees, or provider run IDs.

## Robots behavior {#robots}

We fetch `/robots.txt` first and follow it for every later request, its query
and each redirect included: the page, its sitemap, llms.txt and the
`/.well-known` discovery files. The rules we follow are those of the groups that
name `agentify-scanner`, or of the `*` group when none does. Each of the two
requests sent in an AI agent's name also follows the group for that agent,
`ChatGPT-User` or `Claude-User`: where that group keeps the agent off the page,
the request is not sent. An address on another host of the site is judged by
that host's own robots.txt, read first. A check whose requests it disallows
is marked not assessed, and the report names robots.txt as the reason. If
robots.txt cannot be read, or its rules cannot be decided for an address, we
read nothing it might forbid. We do not bypass that rule.

## Body and safety limits {#limits}

Decoded HTML is capped at 2 MiB, robots at 512 KiB, discovery JSON at 1 MiB, and
sitemap data at 5 MiB. Every DNS result and redirect destination must be public
global unicast; private, local, reserved, metadata, credentialed, and
secret-bearing URLs are rejected.

## Retention {#retention}

Every scan reads the site afresh; no earlier result stands in for it. We do not
retain target raw bodies, cookies, full headers, credentials, or raw IP
addresses. Structured scan facts follow the retention described in the privacy
page.

## Opt out or report a problem {#opt-out}

Send the affected host, approximate UTC time, and request identifier if
available to [{{abuse-email}}](mailto:{{abuse-email}}). Do not email access
tokens, private URLs, credentials, or personal data.
