# What can go wrong

*This page describes `@nuanu-ai/agentify` {{sdk-version}}. A change to the public contract arrives in a new package version.*

You have written the handler, or you are writing it now, and this page is what
will go wrong with it, in one table: each situation, what it does in each
mode, and what you do about it.

One rule decides every row. Faced with not knowing, we either carry the sale
on or stop it, and what decides is where the money is at that moment rather
than how bad the failure looks. While your answer comes before the money, as
in the synchronous mode, your silence costs the buyer nothing and the sale can
go on at a known price. Where the money moves at the moment of purchase, as in
the asynchronous mode and for a parcel, the same silence would leave a buyer
who paid with nothing, so the sale stops before the money moves, or the order
is recorded as unfulfilled after.

## Every failure, mode by mode

| Situation | Synchronous | Asynchronous | A parcel | What you do |
| --- | --- | --- | --- | --- |
| The price check is silent | the sale goes on at the card's price | the purchase is refused before payment, and no order reaches you | as in the asynchronous mode | keep a synchronous card's price current, since in a silence it is the price of the sale |
| You refused | the purchase did not happen and nothing was charged | the paid order is unfulfilled (`unfulfilled`) | as in the asynchronous mode | refuse before the money where you can, in the answer to the price question; after it, refuse at once rather than wait out your deadline |
| Your handler threw, or your process fell over | the order comes again after a pause that grows with each attempt, up to five deliveries in all, while its deadline lasts | as in the synchronous mode | as in the synchronous mode | throw for a failure that may pass, and keep refusals for "this cannot be delivered" |
| No answer by the deadline | nothing was charged (`expired`) | the paid order is unfulfilled (`unfulfilled`) | the paid order is unfulfilled (`unfulfilled`) | name a deadline you can keep; a late delivery still counts until you close fulfillment |
| The same order arrived twice | answer with the result you gave the first time | as in the synchronous mode | record the same shipment | key your delivery on `order.id` and hand back the first result |
| The answer to the agent was lost | the agent signs a new payment for the same payment request from the same wallet and receives what you delivered, with no second charge; asking the purchase address again without that request starts a new purchase, which is charged again once paid | the agent signs a new payment for the same payment request from the same wallet and is answered with the order, with no second charge; asking the purchase address again without that request starts a new purchase, which is charged again once paid | as in the asynchronous mode | nothing; a repeat that does reach your handler gets the first result |
| The goods ran out | "there is none" in the price check refuses before payment; a refusal at delivery charges nothing | "there is none" in the price check refuses before payment; a refusal after it leaves a paid order unfulfilled | as in the asynchronous mode | list goods that can run out with a price check, and answer it truthfully |
| The charge failed after your delivery | the buyer paid nothing and has no goods (`delivered_unpaid`); a repeat purchase that pays releases them, except after you change your payout wallet, when the repeat is refused and the buyer buys again | cannot happen: the charge comes first | cannot happen | decide whether to revoke what you gave out; the risk is one sale's price |
| Nobody knows whether the charge went through | after your delivery the order reads `payment_unresolved`, and a repeat purchase is refused | the order reads `payment_unresolved` before it reaches you, and is unfulfilled if the charge reports in later | as in the asynchronous mode | skip it in your loops over open orders and wait: Agentify keeps checking in the background, with no time promised |
| Twenty of your purchases already wait for payment | a new purchase is refused with `seller_busy`, HTTP 429 and a `Retry-After`, before its price is asked and before any order exists; nothing is charged, and the agent tries again in a few seconds | as in the synchronous mode | as in the synchronous mode | nothing: a price nobody pays lapses thirty seconds after it is named and frees its place, and a paid purchase frees its own at once. While somebody keeps twenty unpaid purchases open, your sales through Agentify wait, though your price handler and your shop are not asked for them |
| No process of yours has polled for ten minutes | nothing changes: a purchase nobody answers ends with nothing charged | a new purchase is refused with `seller_not_taking_orders` before payment, and so is a payment for a price named before the silence; nothing is charged, and the agent tries again later | as in the asynchronous mode | keep a process running and polling: its first poll lets the next purchase through, and the cards you paused stay paused. Your dashboard says since when your integration has not connected |

Silence from a price check is any of three things: no answer within five
seconds, a server error or a network failure in place of an answer, or an
answer that does not fit the declared shape. The timestamp inside an answer is
carried and not weighed, so an old one is not a silence. A refusal and its
message reach the agent word for word, so write the message for a stranger
([refusal codes](/cards#refusal-codes)).

Neither of the last two is a pause, and nothing has to be switched back on.
The limit of twenty keeps anybody from loading your price handler or your shop
through Agentify with purchases nobody means to pay, and it is counted for you
alone, so one seller's twenty hold up nobody else. The rule about polling
covers only a purchase that charges before its goods, an asynchronous one or a
parcel, because without a process of yours running that buyer would pay for
goods nothing is there to make; a synchronous purchase ends uncharged on its
own when nobody answers. It is asked when the purchase is priced and again
when the payment arrives, so a price named just before your process went quiet
is not charged after. Ten minutes without a poll is when it starts refusing,
and Agentify notices within half a minute after that. A process whose every
handler is busy asks for no new work and so does not poll either: one held up
that long by slow handlers is counted as quiet too, which keeps buyers from
paying for orders it has no room to take. A shop connected through
WooCommerce is never refused for it, because its orders are filled inside
Agentify; a shop that fails answers its price question with the failure.
Both refusals are retryable, and neither charges anything.

An order your package cannot read, such as one carrying a field added after
your release, goes the way of a handler that threw: it is not handed to your
handler, nothing is answered, and it comes again within its attempts, while
everything else on the subscription goes on. Your problem handler receives an
`unread` problem naming the order and the fields it could not read, and
upgrading the package is what reads it ([When Agentify is newer than your
package](/orders#when-agentify-is-newer-than-your-package)).

What each status word means and which of them stay on the list of open orders
is in [Finding out where an order stands](/orders#finding-out-where-an-order-stands);
how long each wait lasts is in [Every time limit](/orders#every-time-limit);
and how a repeat is recognised is in [Telling a repeat apart](/orders#telling-a-repeat-apart).
Whether your handler holds against a repeat is yours to prove with a test
purchase of your own ([The first test sale](/quickstart)),
because nothing on our side sends one order twice on purpose.

## What is not settled yet

- The limit on the share of purchases that run into missing goods, which we
  mean to measure because to an agent such a purchase looks like a promise the
  catalogue did not keep. Nothing counts it yet.
- Whether an answer whose timestamp is too old counts as silence at all.
  Nothing weighs that mark today, so what counts as too old has not had to be
  decided.
- What happens when it is we who go quiet: how your side sees it, and what we
  promise in that case.
- How long a payment whose answer was lost stays unknown. Agentify looks for it
  on the network in the background without charging again, and promises no
  time for that ([When nobody knows whether the charge went
  through](/orders#when-nobody-knows-whether-the-charge-went-through)).
