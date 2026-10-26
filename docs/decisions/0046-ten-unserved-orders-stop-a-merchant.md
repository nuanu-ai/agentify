# Ten unserved orders stop a merchant's sales

Status: the product owner's word of 2026-10-26 is that ten paid orders left
unserved stop all of a merchant's sales, synchronous ones included. Which
orders count and how the stop lifts is proposed.

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

While ten or more of a merchant's orders are `unfulfilled`, every new purchase
of theirs is refused, whichever integration they sell through and whatever the
card's mode. The refusal comes at the unpaid request, before an order is
written or a price is asked, and again before a payment is verified, so a price
named before the tenth such order is not charged after it. A payment for goods
already made and held is let through. The code is `seller_not_fulfilling` with
HTTP 409, and it is not retryable: only the merchant can lift it, and the buyer
can only buy elsewhere.

Only `unfulfilled` counts. An order whose fulfillment the merchant closed does
not, because closing is the merchant acting, and any remedy is then theirs to
arrange with the buyer. Neither does an order whose payment outcome is
unknown, one delivered and left unpaid, or a purchase that ended with nothing
charged, because anybody can produce those without paying. Nothing about the stop is
stored. It holds while ten such orders exist and lifts by itself once a late
delivery or a closure leaves fewer, with no operator involved. The count reads
at most ten rows through the index of a merchant's open orders. The merchant's
dashboard says so while it holds, and the gateway logs it at most once a
minute per merchant.

## Alternatives rejected

Counting purchases that ended uncharged, or price questions left unanswered:
anybody can produce them for free, which the owner's principle rules out.
Stopping only purchases charged before their goods, as the rule about a silent
merchant in [ADR-0043](0043-the-purchase-door-refuses-before-any-charge.md)
does: the product owner chose to stop all of a merchant's sales. A stored pause
resumed by hand: it would make a staffed step of an ordinary sale, when the
stop already ends as soon as its cause does.
