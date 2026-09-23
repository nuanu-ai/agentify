# A refund owed: what the system does, what practice says, what was weighed

Date: 2026-09-23. A research note that may be rewritten. The decision it
supports is ADR-0028.

## The question

An asynchronous order whose delivery deadline passes without goods becomes
`refund_due`. The buyer has paid, the money is already in the merchant's
wallet (ADR-0019), and the merchant owes either the goods or the money back.
Two questions had no answer on record. The first is whether the merchant may
still deliver after the deadline, or whether the order must then end in a
refund. The second is how long such a debt may stand before somebody other than
the merchant acts. The design backlog (item 8) asked for a pattern taken from
sellers who already do this, not one invented here.

## What the system does today

The merchant's delivery route accepts a late delivery. Its description in
`packages/contracts/src/api.ts` (`deliver_order`) and the portal's Orders page
say the same thing. Where the deadline has passed and the refund has not yet
gone out, delivering closes the debt; once it has gone out, the call returns
an error.

The order state machine in `packages/core/src/orders/machine.ts` has a
`refund_settled` event that ends the debt as `refunded`. After that event a
delivery is refused as final (`refund_already_settled`). Nothing in the
gateway, the cabinet or the SDK produces the event, so no order reaches
`refunded`.

A `refund_due` order stays on the list of open orders that a merchant's worker
walks. The worker's own retry can therefore be the late delivery.

The cabinet tells the merchant to return the money from their own wallet. It
does not show the address the payment came from. The gateway does keep a
record of the paying wallet on the order (`paidBy`), but with two
limitations. It holds that wallet only where the payment layer named one, and
otherwise holds a fingerprint of the payment. It also stores the address in
lower case, while ADR-0019 wants an address that money is sent to shown
checksummed.

The change that added `status_url` to the agent's order (pull request #13,
merge e4c4f2e) was checked on a local stack with an asynchronous card whose
deadline was set to thirty seconds. The merchant was stopped and the card was
bought, and thirty-two to thirty-four seconds later the order read
`refund_due`. When the merchant was started again it delivered, the gateway
answered `debt_closed_by_delivery`, and the order read `delivered` with the
goods. In the same run, republishing the card with a deadline of an hour
changed the number the catalog showed. It did not change the deadline the open
order was held to, which is fixed when the order is opened.

## What practice says

Three sources were read on 2026-09-23 and are paraphrased here.

eBay's Money Back Guarantee gives the seller three business days to resolve an
item that has not arrived. The clock starts when the buyer reports it. After
that the buyer can ask eBay to step in, and eBay usually decides within about
two days and refunds
([item hasn't arrived](https://www.ebay.com/help/buying/returns-refunds/get-help-item-hasnt-arrived?id=4042),
[Money Back Guarantee](https://pages.ebay.com/ebay-money-back-guarantee/)).

The EU directive on digital content, Directive (EU) 2019/770, lets a consumer
terminate the contract when the trader fails to supply (Article 13). Where a
specific time was essential, the consumer may terminate at once. The trader
then reimburses without undue delay, and within fourteen days of learning of
the termination (Article 18)
([text](https://www.legislation.gov.uk/eudr/2019/770/body/data.xht?view=snippet&wrap=true)).

Cryptorefills is a seller already paid by agents over x402 (see
`05-merchant-contract.md`). Its terms give it up to two weeks to investigate
an undelivered order, counted from the day the problem occurred (section
3.2.5). The refund is a return transaction to a wallet address the buyer
provides (3.2.6, 3.2.6a). Customer care may offer the product instead of the
refund, and a buyer who accepts gives up the refund (3.2.6)
([terms](https://www.cryptorefills.com/blog/terms-and-conditions/)).

The three sources agree on a shape. The seller gets a short window of a few
business days to put things right, then somebody else steps in, and within
about two weeks the buyer holds the goods or the money.

They differ from what is decided here in two ways, and both differences are
deliberate. First, each source starts its clock at a different moment: the
buyer's report, the trader learning of a termination, or the day of the
problem. Here both clocks start at the delivery deadline, because that is when
the debt arises without the buyer, who is often an agent with no channel to
report on, having to say anything. Second, practice lets the buyer choose
between late goods and the money. Here late goods are accepted without asking
the buyer, because an agent has no route to express that choice. Building one
was rejected for the pilot.

## The options weighed

Refusing late goods once the deadline passes would make `refund_due` a dead
end today. No refund can be paid through the system and none can be recorded,
so the buyer would hold neither goods nor money. The pilot sells only goods
that can be issued again, such as access, keys and subscriptions, and for those
a late delivery is almost always worth more to the buyer than a refund nobody
can carry out.

A grace window after the deadline would add a second deadline that both the
agent and the merchant have to learn, plus a configuration knob. It would not
stop the double outcome either, because a merchant can refund inside the window
just as well as outside it.

Letting the buyer choose between late goods and money would need a route
through which an agent writes to its order. The order identifier would be the
only proof of who is asking (ADR-0011), and that is too much surface for the
pilot.

The option taken is to allow late goods until a refund is recorded. It keeps
most of what the contract already promises and adds the missing pieces: a
way to record a refund, the payer's address in front of the merchant, and
honest words. It narrows one promise. The error for a late delivery now comes
once a refund is recorded, instead of once it has gone out, because a refund
nobody reports cannot be seen here. That leaves one case open, which the order
machine's own comments also name: a refund already on its way and not yet
reported races a late delivery, and the buyer may end up with both.

## The numbers

The operator steps in after three business days, and the buyer holds the goods
or the money within fourteen days of the deadline. The first number follows
eBay; the second follows the EU directive and agrees with Cryptorefills. The
operator applies them by hand, with no timer, because there are few merchants
and the charter moves a rule into a machine only after it has slipped past
people. Business days are the operator's measure. An agent has no time zone
to count them in, so anything an agent is told is stated in hours from the
deadline, or not at all. At pilot prices of a few dollars, paying the buyer
back from Agentify's own funds as a last resort costs less than a buyer left
with neither goods nor money.

## Still open

A merchant who signed themselves up has no way to reach the operator today. Until
the cabinet names one, such a merchant can close a debt only with goods.
Whether and when agents are told the fourteen days depends on the system
keeping them. When the timeline moves into the machine, a mail to the merchant
about the debt comes with it.
