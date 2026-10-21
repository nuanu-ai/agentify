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
2026-10-21: "report the merchant's first card; keep the click 30 days", and in
the same way: "like the registration, no boxes, only a line in the policy". The
advice on record concerned the registration. The privacy page states both.

A registration is an address's first verification in the identity of ADR-0026,
by a mailed link's press or a Google sign-in's return, never a returning
verified account or a later merchant; it is reported once per account as
`{"clickid": "<click>", "event": "reg"}`. A store is connected when the merchant
the account names publishes its first card ever at or after that registration
and less than 30 days after it, the operator's approval of a live card included;
it is reported once per merchant as `{"clickid": "<click>", "event": "lead"}`,
the tracker's word for it, for its earliest such registration whose own report
was not refused or given up, once that report was delivered, so the tracker
never hears of a store before its registration. The dashboard alone posts both,
to `https://aisamuraihub.com/postback` with the tracker's key in
`x-postback-key`; nothing else about the person or the store leaves, and the
scanner keeps no click.

Where reporting is on, one click identifier of the tracker's form travels with
the sign-in it starts, in the claim ADR-0026 §1 keeps with a link's token or in
the server's record of a Google sign-in's single-use state, never in a cookie of
ours or in what Google is sent. Anybody can ask for a link for any address, and
its press reports the click of whoever clicked the ad, which says nothing about
the address's owner.

Each report keeps its own copy of the click from the verifying transaction until
it is delivered, refused or given up, a day after the reported fact at the
latest, and no click outlives 30 days from the registration; the outcomes stay
until the account's deletion. Delivery is at least once, which the tracker
absorbs: it keeps one `reg` per click and, as its team stated on 2026-10-21, one
`lead`, which it passes to Meta as a Lead dated at its arrival. Only the live
channel reports, both reports under one switch.

## Alternatives rejected

A box on the sign-in form, which the advice found unnecessary and which leaves
every unticked registration unmeasured; the consent banner, which keeps optional
measurement off until allowed; a cookie of our own, which a link opened on
another device lacks; the scanner's outbox, across the boundary ADR-0026 §2
draws; signing the click, public to anybody who clicks the ad; the test channel,
whose sign-ups are not real. For the store: a merchant's creation or first key,
which says nothing about a connected store; the first payment, a buyer's act; a
fact recorded inside the gateway's publish, needless since a card exists only
once published and the live channel deletes none; a click kept until a first
card comes, however long that takes.
