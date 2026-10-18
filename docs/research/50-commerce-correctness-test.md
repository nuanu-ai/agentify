# A correctness test of the commerce surface, and the four defects it found

Date: 2026-10-18. A research note that may be rewritten. It records a bounded
adversarial test of the commerce product, run on 2026-10-15 against
`e11fef741e875ef6f9c42465a6b27577dd2921a1`, the four product defects it
confirmed, how each was fixed, and what the test left untouched. The test's own
code, its recorded results and its scripts were kept apart from `main`, in
[pull request 143](https://github.com/nuanu-ai/agentify/pull/143); each fix
carries only the smallest test that shows its defect, beside the code it
covers.

## What was exercised

The question throughout was whether information the product accepts stays
usable, whether a refused request leaves state as it was, whether an outcome
the product cannot know is kept apart from one it knows to have failed, and
whether one sale can cause a second payment or a second delivery. Most of the
work ran offline against local stand-ins for the chain, the payment layer and
the merchant's shop. Every document a caller sends (cards, purchases, worker
polls, key issuance, merchant settings, price answers, handler answers and
order-list queries) was given a list of well-formed and malformed examples,
256 in all, each with the verdict the contract promises, and accepted cards
were published, read back and shown to an agent in each of the short and long
spellings a card may be written in. The order state machine ran 512 random
walks of 128 events across its four fulfilment modes, with and without a live
price check, and 108 orderings of three events competing for one order, most
of them around a deadline about to expire. Each of the SDK's six merchant
calls met 60 answers ranging from success through refusals, rate limits and
server errors to malformed and truncated documents, and its worker was stopped
at 34 different moments of an order's handling, once with a restart. Each of
the dashboard's eight forms was sent with a valid session, with none, from a
stale page of the other merchant, and from a foreign origin, for two merchants,
and 48 random browser walks went through its pages on desktop and mobile
widths. The WooCommerce connector was tested on which products and shop
settings it admits, how a catalogue grows past a page, how a failure at each
remote step is handled, and how an uncertain order is recovered. The wallet's
payout request met ten kinds of provider answer, and the gateway's payment
challenge was measured at eight card widths.

A capped live run on the test channel then exercised the consumer flows end to
end: six SDK scenarios (a refused confirmation card, synchronous and
asynchronous delivery, a handler refusal, a redelivery and a late delivery
closing a refund owed) and one purchase of a download imported from the
WooCommerce lab. Five payments of 0.01 test USDC were reconciled on Base
Sepolia, each receipt matched to exactly one token transfer into the merchant's
payout split and no other transfer found in the queried block ranges. Two
merchant payouts were then sent with the product's own payout builder and
verified to the token unit against the split contract's balances and credits.
The application's database backup was restored into a temporary database and
read back.

## The four defects and how each was fixed

The fixes below carry a fifth: the product check's settings reads had the same
gap as its product read, found while that was being fixed.

### A published card whose payment challenge no ordinary client can read

The gateway accepted a card with 256 declared parameters, a 7,867-byte
publication, and answered its purchase probe with an 18,896-byte
`PAYMENT-REQUIRED` header. Node's `node:http` and its native `fetch` read at
most 16 KiB of response headers and refused it (`HPE_HEADER_OVERFLOW`,
`UND_ERR_HEADERS_OVERFLOW`), so the merchant was told the card was published
and no agent could buy it. The header grows with what the discovery
declaration copies from the card: the description, the tags and every declared
field's name, which appears in the example body, in its schema and, for a
result, in the example output. Field titles do not reach it, and neither does
the card's own title. Nothing bounded the number of fields or the length of
their names.

The product owner decided that a card whose challenge would exceed 8 KiB is
refused at publication, and the reason is recorded in
[decision 0012](../decisions/0012-discovery-declaration.md). Publishing now
builds the challenge the card would be answered with, through the same encoder
the probe uses, with every part that can change after publication taken at its
widest: the longest listing name the name rule admits written in a character
JSON escapes to two, every reason a challenge gives with and without an order,
an order and an item identifier as the stores issue them, an amount with every
digit an amount may carry, and an address. A card over the bound is refused
with the finding `challenge_too_large`, which states the width and what to
shorten. The reasons a challenge gives became one typed set, so every reason
the code can send is measured when a card is published. The bound is the
publish's alone: stored cards are read back without it and are never measured
again. The portal's card reference names the bound, and says that the SDK's
local check cannot see it. The 16 KiB that Node's clients read is measured; the
choice of half of it, leaving the rest for the response's other headers and for
intermediaries, is a judgment.

The widths below are for the portal's example card with parameters named
`field_0`, `field_1` and so on added to it. The header actually sent is the
one the probe returned on a default local deployment; the widest measure is
what publishing compares with the bound, on a deployment answering at
`https://agentify.ad`.

| Declared parameters | Header actually sent (bytes) | Widest measure (bytes) |
| ---: | ---: | ---: |
| 1 | 1,844 | 2,132 |
| 32 | 3,848 | 4,132 |
| 64 | 5,936 | 6,224 |
| 128 | 10,192 | 10,480 |
| 256 | 18,896 | 19,184 |

On that card 94 parameters are published, at a widest measure of 8,184 bytes
and an actual header of 7,896, and 95 are refused, at 8,248. Before the rule
was built it was checked that an ordinary card fits. A card with its
description and tags at their limits, a 500-character description in Cyrillic
(two bytes a character in UTF-8) and five tags of 32 characters each written in
a character JSON escapes to two, and with five purchase parameters and five
result fields named in 32 characters, measures 4,916 bytes; a parcel with the
same description, tags and parameters, whose example body and schema also
carry the address block, measures 6,828. Field names have no length limit of
their own, so the tightest ordinary case found, a parcel with the description
in Chinese characters (three bytes each) and 64-character field names, is a
choice rather than a ceiling; it measures 8,136 bytes, inside the bound by 56.
A description the card schema admits but no editor writes, 500 unpaired UTF-16
surrogates, is escaped by JSON to six bytes a character and takes a parcel with
five short parameters to 8,632 bytes, over the bound. The measure holds only
for what the code and the configuration are when a card is published: a later
change to the public base address, the payment network, the wording of a
challenge or the declaration built from a card widens every challenge, and
nothing measures the cards already published again.

### A malformed wallet acknowledgment shown as a sent payout

The dashboard's payout request returned "sent" after any answer to
`wallet_sendCalls`, so `null`, `{}` or `{ id: 7 }` made the settings page tell
the merchant the payout had gone out. EIP-5792 acknowledges a batch with an
object carrying a string identifier. The request now calls a payout sent only
when the answer names a batch, either in that object or as the bare string an
earlier version of the method returned, which the Base Account SDK's own types
still describe. Any other answer is the outcome in which the page says it does
not know whether the payout went out and asks the merchant to check the payout
contract before sending another. Rejection, a provider failure and a lost
session keep their outcomes.

### A WooCommerce product document naming another product

The connector's product check asked the shop for product `N`, parsed whatever
came back and returned it under `N`, so a cache or rewrite in front of the shop
could lend a card another product's eligibility, price and file. A document
whose identifier is not the one asked for is now refused for good, in words
that name both. The settings the same check reads had the same gap: each
settings document carries the setting's own `id`, which WooCommerce's REST
settings controller always writes into a single setting's answer and matches
to the address asked, and the connector read only the value, so a cache that
confused two settings' addresses could lend one setting's answer to the other.
A setting the product's class needs is now taken only from a document naming
that setting. The other sibling reads were checked for the same gap. The read
of an exact order for recovery returns the order's own identifier and its
caller compares it with the one asked for; the read of a shipped order holds the
answer to the sale's own identifier in `transaction_id`. The shipping-rate
read, which adds the product to a fresh Store API cart and reads the rates off
the cart, does not check that the cart holds the product it added; that is a
different read and is left as it is.

### A lost answer about a setting the product does not need

The product check asks for the product and nine shop settings in one batch, and
promised that only the settings bearing on the product's class decide. A
request lost to a timeout or a reset on any one of them failed the whole batch
before the class was known, so losing the shipping-destination setting blocked
a download and losing the download-login setting blocked a parcel. Each
endpoint now has its own outcome. A lost request, or an answer whose body broke
off, counts only where the endpoint bears on the class, and the product itself
always does; there a lost request still asks for the check to be run again.

## What the test did not cover

The SDK's handling of a connection lost before the response headers or in the
middle of a body was registered and not run. Complete but truncated documents
and rate-limit envelopes were tested in its place, which does not show that a
broken exchange is reported as an unknown outcome. The WooCommerce shipping
failures went through a seam that stands in for the cart's result, not through
the real sequence of cart requests, and the connector's grant lifecycle ran
against the in-memory store rather than Postgres, so no database interleaving
was tested. Scanner flows that need a database were not exercised: accepted
scans, reports, shares, registration, consent and deletion, and the delivery
from a worker to a report. The header width was measured against Node's
`node:http` and `fetch` only. Browsers, other HTTP libraries and the proxies on
a buyer's path were not measured, and the 8 KiB bound leaves room for them by
judgment rather than by measurement. No connected Coinbase or Base wallet was
seen sending a malformed acknowledgment; the live payouts used a controlled
signer and not the dashboard's wallet component.
