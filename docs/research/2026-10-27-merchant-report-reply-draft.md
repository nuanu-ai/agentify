# Draft reply to Stefan Abrudan's report

Draft only. Not sent. PR #211 is merged; PR #215 is under preparation and has
not established production rollout. Update the release and TEST evidence before
sending this reply.

Thank you for the detailed report and for separating your runner's ENG01 issue
from Agentify's tests. We have kept that distinction: the synthetic 9.99 USDC
case is not an on-chain incident.

The buyer example now saves the payment requirements before signing and resumes
that purchase after restart. It opens another purchase only when explicitly
asked. Its journal is private even when the file already exists, and a failure
to save stops payment. PR #211 contains those changes and a bounded TEST
purchase/recovery check with no additional debit during recovery.

We considered giving buyers their own private order key before the first
request. That would change order ownership and the retry contract across
purchase, discovery, retention and existing purchase paths. We chose the
contained example fix for the reported restart failure at this stage. A fresh
payment signature for recovery remains an awkward part of the current contract;
Sign-In-With-X remains the direction for replacing it. We are not publishing
a buyer npm package. The consequence map is retained as research rather than
presented as a measure of implementation effort.

The follow-up branch adds `Cache-Control: no-store` to purchase, recovery and
order-bearing error responses. The status route already had it. We have not
established that any cache exposed an order.

The insufficient-funds wording had already changed in PR #201. A TEST recheck
refused payment without spending, but the upstream service returned a generic
failure. Offline cases cover explicit insufficient-funds codes and their
funding advice; we cannot claim reliable live balance diagnosis from that
recheck.

For asynchronous and parcel sales, the approved response on the follow-up
branch is to require the existing merchant website before publication and the
first payment. Buyer instructions explain prepayment and direct the buyer to
the merchant's terms. Already accepted fulfillment and paid recovery continue.
A separate machine-readable settlement/remedy policy is deferred. A website
link does not verify its ownership, policy content or any refund.

The branch also exposes the build revision and worker contract on public
health, with unknown values distinguishable from known ones and private
configuration excluded. That makes it possible to attribute a test to a build.

Your unpaid-purchase observation led to a separate admission change in PR #215.
Unpaid prices no longer create durable orders or hold places in a fifty-order
limit. An authenticated price travels through the normal x402 retry; the order
is created when payment is presented. Per-merchant gates bound price work,
and ready accepted orders are selected before price questions. WooCommerce
caches repeated reads and reuses a bounded local cart pool. These are initial
bounds, not a measured capacity guarantee: sustained shop capacity, server-side
session cleanup and shared database/facilitator isolation remain unverified.

PR #211 also refuses new purchases when the merchant's own process has not
recently polled with a compatible contract. A card therefore cannot keep
accepting first payments behind an incompatible worker. Production activation
still requires the matching SDK release and deployment; publishing a card is
not proof that its fulfillment process is compatible.

The remaining dispositions are explicit:

| Item | Disposition |
| --- | --- |
| ENG06, a different repeated delivery | The original goods are preserved. A merchant diagnostic remains a proposal; no implementation decision yet. |
| F13, transient polling errors | Cause unconfirmed; the observed worker recovered without an affected order. |
| F14, a price question with example locality | Sender unconfirmed. A crawler or validator is a hypothesis. |
| API, settlement and RPC timing | Separate measurement still needed. |
| Coinbase TLS validation and discovery | Not confirmed from our side in this work. A successful validator response alone would not prove a visible discovery listing. |

The full status and evidence are tracked in
[the finding register](2026-10-27-merchant-report-status.md). Release identifiers
and the final TEST result must be added before this draft becomes a report of
what is available to merchants.
