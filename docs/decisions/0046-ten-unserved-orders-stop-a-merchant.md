# Ten unserved orders stop a merchant's sales

Status: the product owner's word of 2026-10-26 is that ten paid orders the
merchant took on and left without delivery and without closure stop all of
their sales, synchronous ones included. They are counted in total, with no
time window. A refused order counts until the merchant closes it, and the rule
holds on the test channel as on the live one. Proposed and not yet his word:
the HTTP 409 and the refusal being not retryable, letting through a payment
for goods already made and held, leaving out the orders Agentify never handed
over, counting for a WooCommerce seller only the parcels the shop took on, and
taking a stopped seller's cards out of the catalogue and refusing a look at
them.

## Context

An order is `unfulfilled` when the buyer's payment settled and no delivery is
recorded; it stays open to a late delivery until the merchant closes it, and
Agentify confirms no refund ([ADR-0028](0028-late-goods-settle-a-refund-owed.md)).
A merchant who keeps leaving orders like that costs one buyer after another
real money. The product owner's principle is that nobody may be able to stop a
merchant's sales without paying, so the rule counts only what costs a buyer.

## Decision

While ten or more such orders of a merchant's exist, every new purchase of
theirs is refused, whichever integration they sell through and whatever the
card's mode, and their cards are not offered to agents. The refusal comes at
the unpaid request, before an order is written or a price is asked, and again
before a payment is verified, so a price named before the tenth such order is
not charged after it. A payment for goods already made and held goes through,
since that order was served. The code is `seller_not_fulfilling` with HTTP
409, and it is not retryable: only the merchant can lift it, and nothing says
when.

Whether the merchant answers for an order is decided once, as it becomes
`unfulfilled`, and kept on it while it stays so. A merchant selling through
their own code answers for an order their process was handed, and for one
they refused themselves before any hand-over. A WooCommerce seller answers
only for a parcel the shop took on. The connector inside Agentify delivers a
download itself, so whatever stops a download is Agentify's, and so is a
refusal before the shop's order exists or a creation that never reported
back. Any other order whose deadline passed before Agentify handed it over
does not count, because the record cannot say whether the merchant or
Agentify failed it, an order whose charge's answer was lost and reported in
late among them. An order the merchant closed does not count: any remedy is
then theirs to arrange with the buyer. Neither does a purchase that ended with
nothing charged. Nothing about the stop is stored; it lifts by itself once a
late delivery or a closure leaves fewer than ten, with no operator involved.
A known limit: a parcel the shop completed, whose shipment the connector could
not read before its time to ship ran out, counts although the failure may be
Agentify's, since no failed read is recorded. It heals once the shipment is
read, because a shipment recorded late ends the order.

## Alternatives rejected

Counting purchases that ended uncharged, or price questions left unanswered:
anybody can produce them for free, which the owner's principle rules out.
Stopping only purchases charged before their goods, as the rule about a silent
merchant in [ADR-0043](0043-the-purchase-door-refuses-before-any-charge.md)
does: the product owner chose to stop all of a merchant's sales. A stored pause
resumed by hand: it would make a staffed step of an ordinary sale, when the
stop already ends as soon as its cause does. A time window or a share of
sales: an old order left without delivery or closure is still a buyer without
goods or an answer. Counting only the merchant's ten most recent paid orders,
a streak, so that a large merchant's scattered failures never add up: the
product owner considered it and kept the total (2026-10-26). Exempting the
test channel: the owner wants it to behave as live.
