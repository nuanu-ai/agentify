# 0046. A copy of a person's data goes only to the address they are signed in as

Date: 2026-10-26
Status: accepted (the product owner, 2026-10-26: «Да: запрос копии данных
исполняется автоматически, копия уходит письмом на подтверждённый адрес, на
экране сказано когда.»); what the copy holds and leaves out, and the schedule
of its tries, are this record's proposal

## Context

A person signed in on the data request page can ask for a copy of the data
held about their address. Agentify has no staffed service to answer such a
request by hand. A copy of everything held about an address describes a person
and their shop more fully than anything else the product produces, so who may
receive one is a security boundary.

## Decision

A copy is made only when a person signed in as an address presses for it, and
it is mailed to that address and nowhere else. The sign-in is the proof that
the address is theirs: it was opened from a link mailed to the address, or
Google vouched for it (ADR-0026). The scanner takes the address from the
session, and the dashboard reads the data held for that same value and mails
the copy to it, so nothing anywhere names a second address. A press from a page
loaded for another address is refused, as every account request is.

The copy is one JSON file attached to the message, sent through the mail
provider the product already uses; no link to it exists. It holds what both
databases keep for the address: the scanner's lead, registrations, owned
reports and analytics events; the dashboard's account,
Google link, sessions and ad reports; the merchant the account names, with its
keys, cards, orders, payout splits and WooCommerce connection; and the
operator's journal rows about the account and the merchant. Each field is named
in the code, so a column added later stays out until somebody puts it in.

It leaves out what would let its holder act as somebody (session tokens,
passwords, Google's tokens, key digests, the shop's key and secret) and what
may be another person's: colleagues on the merchant, buyers' inputs, addresses,
payments, order keys and goods, the acting operator, browser visits and their
privacy choices, and a phone typed on a registration the mailbox never
confirmed, since anyone can type any address. An address being deleted gets a
copy that says so and holds none of its reports. The file lists what it leaves
out, and a cut list says how many rows there are.

The first try is made while the person waits; tries after a refusal or a lost
answer follow 1, 5, 15 and 30 minutes later, each counted as it starts, and the
page says for how many minutes they go on. After five tries with none
confirmed the request gives up and the operator's page counts it; a copy too
large for the dashboard ends at once. Every try of one request carries its
identifier as the provider's idempotency key, so a try after a lost answer
delivers no second copy, and an outcome nobody confirmed is said as not known.
A press within ten minutes of a mailed copy, or during a try, makes no second
copy. A request keeps the address, encrypted, only while tries remain; its
fingerprint and dates go thirty days after it settles, or with the address's
reports.

## Alternatives rejected

**A short-lived download link that opens only for the signed-in owner.** A
second route handing out the whole copy, with its own check and expiry, where
an attachment needs only the provider in use and no address on the web. **A copy only
for an address with reports.** A seller who signed in with Google holds a
dashboard and possibly no report, and would be told nothing is held. **An
operator answering by hand.** There is no staffed service, and the request
would wait on somebody's attention. **Copying whole rows.** A column added
later, a token among them, would leave by email without anybody deciding it.
