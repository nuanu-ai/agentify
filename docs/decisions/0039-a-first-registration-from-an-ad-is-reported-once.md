# 0039. A first registration from an ad is reported once, with consent

Date: 2026-10-15
Status: accepted (the product owner, 2026-10-15)

## Context

The marketing team buys ads leading to landing pages hosted by AI Samurai, an ad
tracker, whose buttons open the dashboard's sign-in page with the tracker's
identifier for the click, the click identifier, in the address
(`/dashboard/sign-in?clickid=...`). The team pays for such a person registering,
which only we can tell the tracker, and telling a third party about a person
needs their consent.

## Decision

A registration is an address's first verification in the identity of ADR-0026,
writing a missing account or verifying an unverified one: the press of a mailed
one-time link, or a Google sign-in's return. A returning verified account, an
unpressed or dead link, a refused Google return and a merchant attached later
are not. The dashboard alone reports a consented registration, once, as
`POST https://aisamuraihub.com/postback` with the tracker's key in
`x-postback-key` and the body `{"clickid": "<click identifier>", "event":
"reg"}`; no address, token, account, merchant or campaign tag leaves, and the
scanner keeps no click.

Where reporting is switched on and the sign-in page was opened with a click
identifier of the tracker's form, the page shows one unticked box naming AI
Samurai, which goes with whichever way in is pressed; unticked, nothing is kept
and no cookie is set. Ticked, it permits keeping the click identifier, the
moment of the tick and the wording's version with the sign-in it starts: in the
claim ADR-0026 §1 keeps with a link's token, or in the server's record of the
Google sign-in's single-use state, which the browser and Google never see.
Anybody can ask for a link for any address, so its owner confirms at the press:
where it would register the address, the link's page says what AI Samurai would
be told and offers two buttons of equal weight, to sign in telling it or
without. Google needs no second step: the browser that ticked the box is the one
Google sends back with the address verified, so the tick and the press are the
owner's. An unused link's record, and an abandoned Google sign-in's state after
its ten minutes, are cleared by requests for links from a week after expiry.

With that consent, the transaction that verifies the address writes one row for
the account in a table of its own: the click identifier, the tick's moment and
wording version, and the report's state; the row is dated by the sign-in. Once
the report is delivered, refused or given up a day after the registration, the
click identifier is erased and the rest stays until the account's deletion.
Delivery is at least once, safe because the tracker keeps one `reg` per click.

Only production, the live channel, reports: `REGISTRATION_POSTBACK_ENABLED`
switches it on with the key in `REGISTRATION_POSTBACK_KEY`; the process refuses
to start with the switch on and no usable key, or on the test channel at all,
and a laptop posts only to a fake receiver. Switched off, a sign-in records
nothing and each pending report is given up a day after its registration.

## Consequences

Fewer registrations are reported than happen. Rejected: asking only at a link's
request (anyone can request one for any address); asking only at its press (the
click would be kept before any opt-in); a confirmation page after Google, asking
again the person who just consented; a cookie of our own, which a link opened on
another device lacks and a Google sign-in does not need; the scanner's outbox,
which needs tables ADR-0026 §2 keeps the dashboard out of, or a second sender
there, a dedupe across components; signing the click identifier, public to
anybody who clicks the ad; the site's consent banner, a call across components
for one flag; and reporting from the test channel, which would hand the tracker
test sign-ups as real ones.
