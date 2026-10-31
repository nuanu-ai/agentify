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
loads no third-party counter; a screen view is the server's observation while
answering, an undercount where the browser answered a prefetched click itself.

The contract is the analytics team's `commerce-v1`, and nothing leaves outside
it: the eleven events `agc_dashboard_viewed`, `agc_auth_result`,
`agc_merchant_created`, `agc_setup_result`, `agc_card_publish_result`,
`agc_selling_changed`, `agc_ui_blocked`, `agc_order_created`,
`agc_payment_result`, `agc_order_outcome_changed` and `agc_practice_opened`, each with its fixed
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

A setup result is recorded where the server learns the step's outcome, once
per change, and its `step` is one of a fixed list. `platform_answer` is the
platform a merchant chose. `woo_preflight` is the public catalogue estimate
before access, whose counts cover only the products it read and which carries
no counts when the catalogue could not be read. `woo_connect` completed means
a request for access to a shop was saved, and `woo_connection` that the access
arrived. `woo_check` is a finished shop check, completed or partial, counting
only the products it read; `woo_import` is a finished publication, the one
after an admission included. `seller_name` counts a seller name wherever it is
written, in Settings or by a request for live sales; `seller_site`,
`payout_wallet` and `api_key` count the site, the wallet and a key.
`live_request` is a merchant's request for live sales, `live_decline` an
operator's decline of one and `live_approval` an admission. How the onboarding
screens record each is in
[research note 92](../research/92-merchant-onboarding.md).

An event is one row in an outbox, written in the transaction of the fact it
records, so a rolled-back fact leaves no event, and checked against the
contract only when it is sent, so a broken event is refused there rather than
failing a sale. Its id and time are fixed when it is written and sent
unchanged on every attempt: delivery is at least once, and a repeat carries
the id Nuanu already has. An event more than seven days old is given up
unsent. What this relies on Nuanu to do with an event's id and time, where
that comes from and what of it is not yet verified, is in
[research note 84](../research/84-nuanu-analytics-ingest.md).

The live and test channels send to Nuanu sites of their own with their own
credentials and reference keys, the test channel's events tagged internal; a
sandbox sends only to a receiver of its own. A person can opt
out in the cabinet's settings, and from then on no event about them, or about
the merchant their account names, leaves, whoever acted.

## Alternatives rejected

An analytics script in the cabinet behind a consent banner reports only what a
consenting browser saw, puts credentials or a collector in the page, and
cannot see a payment or an order at all. A separate worker process is not
needed at this volume, and the outbox makes moving the sender into one a small
change later. Batching events into one request would need an endpoint Nuanu
does not document.
