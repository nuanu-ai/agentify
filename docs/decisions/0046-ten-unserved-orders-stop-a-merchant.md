# Ten unserved orders stop a merchant's sales

Status: the product owner's word of 2026-10-26 is that ten paid orders the
merchant took on and left without delivery and without closure stop all of
their sales, synchronous ones included. They are counted in total, with no
time window. A refused order counts until the merchant closes it, and the rule
holds on the test channel as on the live one. Proposed and not yet his word:
the HTTP 409 and the refusal being not retryable, letting through a payment
for goods already made and held, and leaving out the orders Agentify never
handed over.

## Context

An order is `unfulfilled` when the buyer's payment settled and no delivery is
recorded. It stays open to a late delivery until the merchant closes
fulfillment, and Agentify confirms no refund for it
([ADR-0028](0028-late-goods-settle-a-refund-owed.md)). A merchant who goes on
taking money and leaving orders like that costs one buyer after another real
money, and nothing at the door stopped them. The product owner's principle for
any such stop is that nobody may be able to stop a merchant's sales without
paying, so the rule may count only what costs a buyer real money.

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

An order counts when it is `unfulfilled` and the merchant was given it. That
means their own code refused it, or was handed it and let its deadline pass,
or they took it on. A WooCommerce shop's order counts only once the shop took
it on. Agentify's connector draws every shop order and runs inside Agentify,
so its refusal before the shop's order exists is Agentify's failure. So is a
creation that never reported back, which is not known to be the merchant's.
An order that was never handed over does not count, because the record cannot
say whether the merchant or Agentify failed it. That covers an order whose
charge settled only after the purchase was closed on that charge's silence. An
order the merchant closed does not count, because closing is the merchant
acting, and any remedy is then theirs to arrange with the buyer. Neither does
a purchase that ended with nothing charged, which anybody can produce without
paying. Nothing about the stop is stored. It lifts by itself once a late
delivery or a closure leaves fewer than ten, with no operator involved.

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
