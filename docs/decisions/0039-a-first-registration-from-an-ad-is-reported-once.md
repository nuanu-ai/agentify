# 0039. A first registration from an ad is reported once

Date: 2026-10-15
Status: accepted (the product owner, 2026-10-19)

## Context

The marketing team buys ads leading to landing pages of AI Samurai, an ad
tracker, which open the dashboard's sign-in page with the tracker's click
identifier in the address (`/dashboard/sign-in?clickid=...`). The team pays for
such a person registering and judges its ads by it, and only we can tell the
tracker. What the tracker needs is the identifier it issued for a click on our
ad and the fact that the click led to a registration, nothing about the person.

## Decision

Such a registration is reported whatever the person's privacy choices, with
nothing asked on screen, on the product owner's word of 2026-10-19. It rests on
legal advice that stating the report in the privacy policy is enough, and the
privacy page states it; the lawful ground the advice relies on is not recorded
here.

A registration is an address's first verification in the identity of ADR-0026:
a mailed link's press that writes a missing account or verifies an unverified
one, or a Google sign-in's return that writes a missing account (Google refuses
an address whose only account is unverified); a returning verified account, a
refused return or a later merchant is not. The dashboard alone reports it,
once per account, as `POST https://aisamuraihub.com/postback` with the
tracker's key in `x-postback-key` and the body
`{"clickid": "<click identifier>", "event": "reg"}`; nothing else about the
person leaves, and the scanner keeps no click.

Where reporting is switched on and the sign-in page was opened with one click
identifier of the tracker's form, the page carries it to whichever way in is
pressed, and it is kept with the sign-in that starts: in the claim ADR-0026 §1
keeps with a link's token, or in the server's record of the Google sign-in's
single-use state. No cookie of ours holds the click; a Google press sets Better
Auth's state cookie, which holds only the signed state, and Google is sent the
state alone. Anybody can ask for a link for any address, and its press then
reports the click of whoever clicked the ad, which says nothing about the
address's owner. Requests for links clear an unused link's record, and an
abandoned Google state, from a week after it expires.

The verifying transaction writes one row for the account: the click
identifier and the report's state, dated by the sign-in. Once the report is
delivered, refused or given up a day after the registration, the click
identifier is erased; the rest stays until the account's deletion. Delivery is
at least once, safe because the tracker keeps one `reg` per click. Only the
live channel reports, switched on by `REGISTRATION_POSTBACK_ENABLED` with the
key in `REGISTRATION_POSTBACK_KEY`; the process refuses to start with the
switch on and no usable key, or on the test channel, and a laptop posts only to
a fake receiver. Switched off, a sign-in keeps no click and pending reports are
given up a day after registration.

## Alternatives rejected

Asking with a box on the sign-in form and confirming on the link's page: the
advice above found the question unnecessary, it puts a decision in front of
someone who came to sign in, and every box left unticked is a registration the
ads are not measured by. Asking in the consent banner: a banner over the
sign-in form, and the banner promises that optional measurement stays off until
it is allowed, so the report would go only for those who allowed it. A cookie of our own, which a link
opened on another device lacks. The scanner's outbox or a second sender there,
across the boundary ADR-0026 §2 draws. Signing the click identifier, public to
anybody who clicks the ad. Reporting from the test channel, which would count
test sign-ups as real.
