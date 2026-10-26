# 0046. A copy of a person's data goes only to the address they are signed in as

Date: 2026-10-26
Status: accepted (the product owner, 2026-10-26: «Да: запрос копии данных
исполняется автоматически, копия уходит письмом на подтверждённый адрес, на
экране сказано когда.»); what the copy holds and leaves out, and the schedule
of its tries, are this record's proposal

## Context

Pressing Request data access on the data request page used to record a date,
and nothing answered it; the operator's page counted the requests. Agentify has
no staffed service to answer one by hand. A copy of everything held about an
address describes a person and their shop more fully than anything else the
product can produce, so who may receive one is a security boundary.

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
reports, visits, privacy choices and analytics events; the dashboard's account,
Google link, sessions and ad reports; the merchant the account names, with its
keys, cards, orders, payout splits and WooCommerce connection; and the
operator's journal rows about the account and the merchant. Each field is named
in the code, so a column added later stays out until somebody puts it in.

It leaves out whatever would let its holder act as somebody, and whatever is
about another person: session tokens, passwords, Google's tokens, key digests
and the shop's consumer key and secret; colleagues on the same merchant; buyers'
inputs, addresses, payments and order keys, and what a buyer received; the
operator who acted, who is named only as an operator; and keyed fingerprints of
the address. The file says so in its own `left_out` list, and a list it cuts
says how many rows there are in all.

The first try is made while the person waits. A try the provider refuses, or
one that gets no answer, is made again 1, 5, 15 and 30 minutes later, and the
page says for how many minutes the tries go on. After the fifth failed try the
request has failed, and the operator's page counts it until a later copy to the
address is sent. A press within ten minutes of a mailed copy, or while one is
being tried, makes no second copy. A try that got no answer may still have been
mailed, so a retry can deliver the copy twice, and the page says that. A request
keeps the address, encrypted, only while tries remain, and deleting the address
removes its requests.

## Alternatives rejected

**A short-lived download link that opens only for the signed-in owner.** It
needs a second route that hands out the whole copy, with its own token or
session check and an expiry to keep, while an attachment needs nothing beyond
the provider in use and is reachable from no address on the web. **A copy only
for an address with reports.** A seller who signed in with Google holds a
dashboard and possibly no report, and would be told nothing is held. **An
operator answering by hand.** There is no staffed service, and the request
would wait on somebody's attention. **Copying whole rows.** A column added
later, a token among them, would leave by email without anybody deciding it.
