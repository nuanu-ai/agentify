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

A registration is an address's first verification in the identity of ADR-0026:
the press of a mailed one-time link that writes a missing account or verifies an
unverified one; a returning verified account, an unpressed or dead link and a
merchant attached later are not. The dashboard alone reports a consented
registration, once, as `POST https://aisamuraihub.com/postback` with the
tracker's key in `x-postback-key` and the body `{"clickid": "<click
identifier>", "event": "reg"}`; no address, token, account, merchant or campaign
tag leaves, and the scanner keeps no click.

Consent has two steps. Where reporting is switched on and the sign-in page was
opened with a click identifier of the tracker's form, the form shows one
unticked box naming AI Samurai; ticked, it permits keeping the click identifier,
the moment of the tick and the wording's version in the claim, the record
ADR-0026 §1 keeps with a link's token, and unticked nothing is kept; no cookie
is set. Anybody can ask for a link for any address, so the owner confirms at the
press: where it would register the address, the link's page says what AI Samurai
would be told and offers two buttons of equal weight, to sign in telling it or
without. The click counts for the link's hour and goes with the unused link's
record, which requests for links clear from a week after it expires.

On the owner's yes, the transaction that verifies the address writes one row
for the account in a table of its own: the click identifier, the tick's moment
and wording version, and the report's state; the row is dated by the press.
Once the report is delivered, refused or given up a day after the registration,
the click identifier is erased and the rest stays until the account's deletion.
Delivery is at least once, safe because the tracker keeps one `reg` per click.

Only production, the live channel, reports: `REGISTRATION_POSTBACK_ENABLED`
switches it on with the key in `REGISTRATION_POSTBACK_KEY`; the process refuses
to start with the switch on and no usable key, or on the test channel at all,
and a laptop posts only to a fake receiver. Switched off, a press records
nothing and each pending report is given up a day after its registration, so no
registration's click outlives its day; an unused link's goes with its record.

## Consequences

Fewer registrations are reported than happen, since not everybody ticks and
confirms. Rejected: asking only at the request (anyone can request a link for
any address, so the owner must confirm); asking only at the press (the click
would be kept before any opt-in); the scanner's outbox, which needs rows in
tables ADR-0026 §2 keeps the dashboard out of; a cookie, lost on another device;
signing the click identifier, public and real for anybody who clicks the ad; a
second sender in the scanner, a dedupe across components; the site's consent
banner, a call across components for one flag; and reporting from the test
channel, which would hand the tracker test sign-ups as real ones.
