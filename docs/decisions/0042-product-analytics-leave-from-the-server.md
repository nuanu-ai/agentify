# 0042. Product analytics leave from the server

Date: 2026-10-21
Status: accepted; the product owner, 2026-10-21: "do everything as planned,
recording on the server"

## Context

The analytics team needs to see the path from a first sign-in through setup
and a first published card to orders and their payments, and where that path
breaks. It counts in Nuanu Analytics, a Rybbit deployment that takes one event
per request at `/api/track`. Every fact it asks about is already decided by
Agentify's server, inside a transaction of its own; a browser can only report
what it was shown, and only where it runs a script and is allowed to.

## Decision

Agentify's server records every product analytics event and is the only thing
that sends one. The cabinet runs no analytics script, sets no cookie for it and
loads no third-party counter; a screen shown or a problem shown on it is an
observation the server makes while answering the request, so screen views are
an undercount wherever the browser prefetched a link on hover and answered the
click from its cache.

The contract is the analytics team's `commerce-v1`, and nothing leaves outside
it: the ten events `agc_dashboard_viewed`, `agc_auth_result`,
`agc_merchant_created`, `agc_setup_result`, `agc_card_publish_result`,
`agc_selling_changed`, `agc_ui_blocked`, `agc_order_created`,
`agc_payment_result` and `agc_order_outcome_changed`, each with its fixed
fields, the values from its fixed lists and a reason from one fixed list of
codes. A merchant, a person, a card, an order, a payment attempt and an
operation are named only by a reference, the HMAC-SHA256 of the identifier
under a key each channel keeps, prefixed by its kind and cut to 32 hex digits,
so one identifier always gives one reference on one channel and none can be
read back. The person's reference is the event's user only when a person
acted. An amount leaves only with a payment observed paid, as an exact decimal
with its currency. Names, email addresses, wallets, keys, raw identifiers, the
contents of a card or an order, and free text such as an error's message never
leave.

An event is one row in an outbox, written in the transaction of the fact it
records, so a rolled-back fact leaves no event, and checked against the
contract only when it is sent, so a broken event is refused there rather than
failing a sale. Its id and time are fixed when it is written and sent
unchanged on every attempt: delivery is at least once, and a repeat carries
the id Nuanu already has. An event more than seven days old is given up
unsent. What this relies on Nuanu to do with an event's id and time, where
that comes from and what of it is not yet verified, is in
[research note 84](../research/84-nuanu-analytics-ingest.md).

The live channel and the test channel send to separate Nuanu sites with their
own credentials and reference keys, the test channel's events tagged internal.
A sandbox sends only to a receiver of its own; a laptop configured as the test
channel sends to the TEST site, as TEST does. A person can opt out in the
cabinet's settings, and from then on no event about them, or about the
merchant their account names, leaves, whoever acted.

## Alternatives rejected

An analytics script in the cabinet behind a consent banner reports only what a
consenting browser saw, puts credentials or a collector in the page, and
cannot see a payment or an order at all. A separate worker process is not
needed at this volume, and the outbox makes moving the sender into one a small
change later. Batching events into one request would need an endpoint Nuanu
does not document.
