# 0039. What an ad brought is reported to its tracker

Date: 2026-10-15
Status: accepted; the product owner's words are quoted where they are his

## Context

The marketing team buys ads leading to landing pages of AI Samurai, an ad
tracker, which open the dashboard's sign-in page with the tracker's click
identifier in the address (`/dashboard/sign-in?clickid=...`). The team judges
its ads by whether such a person registers and then connects a store, and only
we can tell the tracker. It needs the identifier it issued for a click on our
ad and what the click led to, nothing about the person.

## Decision

A registration is reported whatever the person's privacy choices, with nothing
asked on screen, on the product owner's word of 2026-10-19, resting on legal
advice that stating it in the privacy policy is enough, on a lawful ground not
recorded here. The store is reported too, on the product owner's word of
2026-10-21: "report the merchant's first card; keep the click 30 days". The
privacy page states both; whether the advice covered the second is not recorded.

A registration is an address's first verification in the identity of ADR-0026,
by a mailed link's press or a Google sign-in's return; a returning verified
account or a later merchant is not one. It is reported once per account as
`{"clickid": "<click>", "event": "reg"}`. A store is connected when the
merchant the account names publishes its first card ever, through the API or a
shop import, at or after that registration and less than 30 days after it; a
merchant whose first card came earlier is never reported. It is reported once
per merchant, for its earliest such registration, as `{"clickid": "<click>",
"event": "store_connected", "event_time": <that publication in Unix seconds>}`.
The dashboard alone posts both, to `https://aisamuraihub.com/postback` with the
tracker's key in `x-postback-key`; nothing else about the person or the store
leaves, and the scanner keeps no click.

Where reporting is on, a sign-in page opened with one click identifier of the
tracker's form keeps it with the sign-in that starts, in the claim ADR-0026 §1
keeps with a link's token or in the server's record of a Google sign-in's
single-use state, never in a cookie of ours or in what Google is sent. Anybody
can ask for a link for any address, and its press reports the click of whoever
clicked the ad, which says nothing about the address's owner. Unused links and
abandoned Google states are cleared from a week after they expire.

Each report keeps its own copy of the click from the verifying transaction
until it is delivered, refused or given up, a day after the reported fact at the
latest; the store's goes too when 30 days pass without a first card, so no click
outlives 30 days from the registration. The outcomes stay until the account's
deletion. Delivery is at least once. For `reg` that is safe because the tracker
keeps one `reg` per click; for `store_connected` it relies on the tracker
keeping one per click as well, which the tracker has not confirmed. Only the
live channel reports, each report switched on by itself and the store's only
beside the registration's; the process refuses to start otherwise or on the
test channel, and a laptop posts only to a fake receiver.

## Alternatives rejected

A box on the sign-in form, which the advice found unnecessary and which leaves
every unticked registration unmeasured; the consent banner, which keeps optional
measurement off until allowed; a cookie of our own, which a link opened on
another device lacks; the scanner's outbox, across the boundary ADR-0026 §2
draws; signing the click, public to anybody who clicks the ad; the test channel,
whose sign-ups are not real. For the store: a merchant's creation or first key,
which says nothing about a connected store; the first payment, a buyer's act; a
fact recorded inside the gateway's publish, needless because a card exists only
after a successful publish and is never deleted; a click kept until a first card
comes, however long that takes.
