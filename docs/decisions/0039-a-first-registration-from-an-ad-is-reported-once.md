# 0039. A first registration from an ad is reported once, with consent

Date: 2026-10-15
Status: accepted (the product owner, 2026-10-15)

## Context

The marketing team buys ads leading to landing pages of AI Samurai, an ad
tracker, which open the dashboard's sign-in page with the tracker's click
identifier in the address (`/dashboard/sign-in?clickid=...`). The team pays for
such a person registering, which only we can tell the tracker, and telling a
third party about a person needs their consent.

## Decision

A registration is an address's first verification in the identity of ADR-0026:
a mailed link's press that writes a missing account or verifies an unverified
one, or a Google sign-in's return that writes a missing account (Google refuses
an address whose only account is unverified); a returning verified account, a
refused return or a later merchant is not. The dashboard alone reports a
consented registration, once, as `POST https://aisamuraihub.com/postback` with
the tracker's key in `x-postback-key` and the body
`{"clickid": "<click identifier>", "event": "reg"}`; nothing else about the
person leaves, and the scanner keeps no click.

Where reporting is switched on and the sign-in page was opened with a click
identifier of the tracker's form, it shows one unticked box naming AI Samurai,
which goes with whichever way in is pressed. Ticked, it permits keeping the
click identifier, the moment of the tick and the wording's version with the
sign-in it starts: in the claim ADR-0026 §1 keeps with a link's token, or in the
server's record of the Google sign-in's single-use state. No cookie of ours
holds the click; a Google press sets Better Auth's state cookie, which holds
only the signed state, and Google is sent the state alone. Anybody
can ask for a link for any address, so where its press would register the
address, the link's page asks the owner, with two equal buttons, whether to tell
AI Samurai. Google needs no second step: the browser that ticked the box is the
one Google sends back with the address verified, and a refused return gives
that browser the box again, ticked. Requests for links clear an unused link's record, and an
abandoned Google state, from a week after it expires.

With that consent, the verifying transaction writes one row for the account:
the click identifier, the tick's moment and wording version, and the report's
state, dated by the sign-in. Once the report is delivered, refused or given up a
day after the registration, the click identifier is erased; the rest stays until
the account's deletion. Delivery is at least once, safe because the tracker
keeps one `reg` per click. Only the live channel reports, switched on by
`REGISTRATION_POSTBACK_ENABLED` with the key in `REGISTRATION_POSTBACK_KEY`; the
process refuses to start with the switch on and no usable key, or on the test
channel, and a laptop posts only to a fake receiver. Switched off, a sign-in
records nothing and pending reports are given up a day after registration.

## Consequences

Fewer registrations are reported than happen. Rejected: asking only at a link's
request (anyone can request one for any address) or only at its press (the click
would be kept before any opt-in); a confirmation page after Google, asking again
the person who just consented; a cookie of our own, which a link opened on
another device lacks; the scanner's outbox or a second sender there, across the
boundary ADR-0026 §2 draws; signing the click identifier, public to anybody who
clicks the ad; the consent banner, a call across components for one flag; and
reporting from the test channel, which would count test sign-ups as real.
