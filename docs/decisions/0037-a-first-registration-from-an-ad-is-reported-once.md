# 0037. A first registration from an ad is reported once, with consent

Date: 2026-10-15
Status: accepted (the product owner, 2026-10-15)

## Context

The marketing team buys ads that lead to landing pages hosted by AI Samurai, an
ad tracker, whose buttons open the dashboard's sign-in page with the tracker's
identifier for that click, the click identifier, in the address
(`/dashboard/sign-in?clickid=...`). The team pays for one goal, a person who
clicked such an ad registering, which the tracker learns only from us; telling
a third party about a person needs that person's consent.

## Decision

A registration is an address's first verification in the identity of
ADR-0026: the press of a mailed one-time link that writes a missing account or
verifies an unverified one, whichever page asked for the link. A returning
verified account, a link's page opened without the press, a refused, expired or
spent link and a merchant attached later are not registrations, and a link to a
scanner report carries no click, so it reports nothing. A consented
registration is reported once, as `POST https://aisamuraihub.com/postback`
with the tracker's key in the header `x-postback-key` and the body
`{"clickid": "<click identifier>", "event": "reg"}`, and nothing else leaves:
no address, token, account or merchant identifier, no campaign tag.

Where reporting is switched on and the sign-in page was opened with a click
identifier of the form the tracker issues, the form shows one unticked box.
Ticked, the click identifier, the moment of consent and the version of the
box's wording go into the claim, the record ADR-0026 §1 keeps with a link's
token (the link carries only the token); unticked, nothing about the click is
kept and sign-in is unchanged. No cookie is set. Kept in the claim, the click
lives as long as the link, an hour, survives the link being opened in another
browser or on another device, and belongs to the address the link was sent to.
Each request makes a new link with its own claim, and the link pressed counts.

In the transaction that verifies the address, the dashboard writes at most one
row per account in a table of its own, with the click identifier, the consent's
moment and wording version, and the report's state. Once the report is
delivered, refused by the tracker or given up a day after the registration, the
click identifier is erased; the state, outcome, consent evidence and times stay
until the account's deletion takes the row. Delivery is at least once: a crash
after the tracker accepted a post leaves the row pending and it is posted
again, which is safe because the tracker keeps one registration per click.

Only the live channel, the production deployment, reports. A deployment
switches reporting on with `REGISTRATION_POSTBACK_ENABLED` and holds the key in
`REGISTRATION_POSTBACK_KEY`; the process refuses to start with the switch on
and no usable key, or on the test channel at all, and a laptop posts only to a
fake receiver. The dashboard alone reports to the tracker, and the scanner
keeps no click identifier and sends it nothing. Should ads lead to the
scanner's reports, the scanner passes a consented click with its request for a
report link, and the same moment and sender apply.

## Consequences

Fewer registrations are reported than happen, since not everybody ticks the
box; that is the cost of asking. Rejected: writing into the outbox the scanner
delivers its events from, which needs rows in the scanner's tables that
ADR-0026 §2 keeps the dashboard out of; binding the click with a cookie, which
does not survive another device; an internal "account registered" event table
nothing reads, as the account row records the registration; signing the click
identifier the form carries back, which is public by nature, refused by the
tracker unless it issued it, and real for anybody who clicks the ad; a second
sender in the scanner with a rule for which report counts, a dedupe across
components for one event; asking consent through the site's consent banner on
the dashboard's pages, a call across components for one flag; and reporting
from the test channel, which would hand the tracker test sign-ups as real ones.
