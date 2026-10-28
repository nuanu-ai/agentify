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
| The price check is silent | the sale goes on at the card's price | the purchase is refused before payment with `seller_busy` and asked again ten seconds later; no order reaches you | as in the asynchronous mode | keep a synchronous card's price current, since in a silence it is the price of the sale |
| You refused | the purchase did not happen and nothing was charged | the paid order is unfulfilled (`unfulfilled`) | as in the asynchronous mode | refuse before the money where you can, in the answer to the price question; after it, refuse at once rather than wait out your deadline |
| Your handler threw, or your process fell over | the order comes again after a pause that grows with each attempt to at most {{redelivery-max-delay}}, for up to {{redelivery-window}} after its first hand-over, while its deadline lasts | as in the synchronous mode | as in the synchronous mode | throw for a failure that may pass, and keep refusals for "this cannot be delivered" |
| No answer by the deadline | nothing was charged (`expired`) | the paid order is unfulfilled (`unfulfilled`) | the paid order is unfulfilled (`unfulfilled`) | name a deadline you can keep; a late delivery still counts until you close fulfillment |
| The same order arrived twice | answer with the result you gave the first time | as in the synchronous mode | record the same shipment | key your delivery on `order.id` and hand back the first result; check what a repeat's goods share with the first before revoking anything |
| The answer to the agent was lost | the agent signs a new payment for the same payment request from the same wallet and receives what you delivered, with no second charge; asking the purchase address again without that request starts a new purchase, which is charged again once paid | the agent signs a new payment for the same payment request from the same wallet and is answered with the order, with no second charge; asking the purchase address again without that request starts a new purchase, which is charged again once paid | as in the asynchronous mode | nothing; a repeat that does reach your handler gets the first result |
| The goods ran out | "there is none" in the price check refuses before payment; a refusal at delivery charges nothing | "there is none" in the price check refuses before payment; a refusal after it leaves a paid order unfulfilled | as in the asynchronous mode | list goods that can run out with a price check, and answer it truthfully |
| The charge failed after your delivery | the buyer paid nothing and has no goods (`delivered_unpaid`); a repeat purchase that pays releases them, except after you change your payout wallet, when the repeat is refused and the buyer buys again | cannot happen: the charge comes first | cannot happen | decide whether to revoke what you gave out; if goods cost money to make, sell them asynchronously, as the paragraph below the table explains |
| Nobody knows whether the charge went through | after your delivery the order reads `payment_unresolved`, and a repeat purchase is refused | the order reads `payment_unresolved` before it reaches you, and is unfulfilled if the charge reports in later | as in the asynchronous mode | skip it in your loops over open orders and wait: Agentify keeps checking in the background, with no time promised |
| Your price-question gate is full | the question waits briefly for a place; if none comes, the sale goes on at the card's price without asking your price handler | the request waits briefly for a place, then is refused with `seller_busy`, HTTP 429 and `Retry-After: 2`, before any order is written | as in the asynchronous mode | keep a synchronous card's price current |
| No process of yours has polled for {{silent-after}} | a new purchase is refused with `seller_not_taking_orders` before its price is asked and before any order exists, and so is a payment for a price named before the silence; your cards leave the catalogue, nothing is charged, and the agent tries again later | as in the synchronous mode | as in the synchronous mode | keep a process running and polling: its first poll brings your cards back and lets the next purchase through, and the cards you paused stay paused. Your dashboard says since when your integration has not connected, and [what to check](#your-integration-has-not-connected) |
| {{Unserved-at-most}} paid orders you took on are left without delivery or closure | a new purchase is refused with `seller_not_fulfilling`, HTTP 409, before its price is asked and before any order exists, and so is a payment for a price named before the {{unserved-at-most:ordinal}} such order; your cards leave the catalogue, nothing is charged, and the agent is told that nothing says when it ends | as in the synchronous mode | as in the synchronous mode | deliver late or close fulfillment of those orders, each of which says it counts under Needs you on Orders: once fewer than {{unserved-at-most}} remain, the next purchase goes through with nothing switched back on |

Silence from a price check is any of three things: no answer within
{{quote-response}}, a server error or a network failure in place of an answer, or an
answer that does not fit the declared shape. The timestamp inside an answer is
carried and not weighed, so an old one is not a silence. A refusal and its
message reach the agent word for word, so write the message for a stranger
([refusal codes](/cards#refusal-codes)).

When your price check is silent on a card paid before delivery, the agent gets
`seller_busy`, HTTP 429, with `Retry-After: 10`. It is told that nothing was
charged, that the purchase may go through if it asks again, and that a silence
which repeats means your price check is not answering.

A repeat delivery whose goods differ from the ones the order already holds is
still answered with success, as `already_delivered_other_goods`. The buyer
keeps the goods you delivered first, and the SDK warns you, naming the order.
The two are compared as documents, so a repeat that differs only in, say, when
it was issued may name the same voucher the buyer holds: check what the two
share before revoking anything.

A payment check reserves no money. Several purchases from one wallet can pass
it at once even when the wallet cannot cover all of their charges, and on a
synchronous card you make the goods for each before the charges run. The buyer
receives none of the goods it did not pay for, but your cost of making them
can multiply. If your goods cost money to make, publish them for asynchronous
delivery, so that the payment comes before you make them.

Your price questions pass a gate of your own, for sales through the SDK and
through WooCommerce alike, and another seller's questions never take your
places. It hands your process only questions that can still be answered within
{{quote-response}}, and never one whose wait has ended, and paid orders reach
your process before price questions. A question that finds the gate full waits
for a place inside that same time. If none comes, a synchronous card sells at
its card price, and a card paid before delivery is refused with `seller_busy`,
HTTP 429, with `Retry-After: 2`. Nothing counts prices that were named and not
paid: once its question ends, a price holds no order and no place in a queue.
The gate, like the polling rule, recovers by itself, with nothing to switch on
in the dashboard. An answer of yours that the product is unavailable refuses
that purchase with `not_selling`, which is not retryable.

The facilitator checks your buyers' payments a few at a time, and another
seller's payments never take your places. A paid request that finds no place
within a short wait is refused with `seller_busy`, HTTP 429, with
`Retry-After: 2`, before anything is charged, and the agent sends the same
request with the same payment again. A payment signed by the paying wallet's
own key, from a wallet that holds less than the price, is refused at once, and
the agent is told to fund the wallet. An authorization that is not valid yet,
has been used, or carries a signature the token refuses is refused at once too.
A payment whose signature is not that wallet's own key, as a contract wallet's
is not, and one whose wallet's balance could not be read, wait in a small line
of their own. In either line one wallet holds at most one place and waits for
at most one more, so holding several places in front of a buyer takes several
wallets, each holding the price.

While one request for a price is being checked, another for the same price is
refused with `payment_not_taken`, marked retryable, with `Retry-After: 2`.
That answer does not say whether the first request will be charged, so the
agent sends the same request again to learn how the purchase stands rather
than buying anew. A paid request that fails on Agentify's side before anything
was written for it, for a reason that will not pass by itself, is answered
with HTTP 500 and `gateway_failed`, not retryable, and nothing was charged.

The rule about polling covers every purchase sold through your own code,
whatever its mode. Without a process of
yours running, the buyer of a purchase that charges before its goods would pay
for goods nothing is there to make, and a synchronous purchase could only lapse
after its buyer had signed and waited. While it holds, your cards are not in
Agentify's catalogue, though a look at one still answers with its payment
challenge, so that listings other people build from those answers keep it
through a pause that ends by itself. It is asked when a purchase is priced and
again when its first payment arrives, so a price named just before your
process went quiet is not taken up after; a payment that releases goods you
already made goes through. {{Silent-after}} without a poll is when it starts refusing,
and Agentify notices within half a minute after that. A process whose every
handler is busy asks for no new work and so does not poll either: one held up
that long by slow handlers is counted as quiet too, which keeps buyers from
paying for orders it has no room to take. A shop connected through
WooCommerce is never refused for it, because its orders are filled inside
Agentify; a shop that fails answers its price question with the failure.
This refusal is retryable, as `seller_busy` is, and neither charges anything.

The rule about orders left without delivery or closure counts only an order a
buyer paid for, that you were given, and that has nothing delivered
(`unfulfilled`), so nobody can set it off without paying. Selling through the
SDK, an order you refused after the charge counts, whether your handler
refused it or you refused it by a call before your process was handed it, and
so does one your process was handed, or you accepted, and let run past its
deadline. Selling through a WooCommerce shop, only a parcel the shop took on
counts. Either
counts for as long as it is neither delivered nor closed; closing it, with an
explanation to the buyer if you like, takes it out. They are counted in total,
however old, on the test channel as on the live one. An order whose
fulfillment you closed does not count, and neither does a purchase that ended
with nothing charged. Nor does an order whose deadline passed before Agentify
handed it to your process, such as one whose charge's answer was lost and
reported in only later. For a WooCommerce shop, a download does not count,
because Agentify's connector delivers it itself, and neither does a parcel the
connector refused before creating the shop's order or could not tell whether
it created. Under Needs you on Orders, each order that counts says so.

The rule covers every purchase of yours, a synchronous one too, whether you
sell through the SDK or a WooCommerce shop, and it is asked again when a
payment arrives, so a price named just before the {{unserved-at-most:ordinal}} order is not charged
after. A payment for goods you already made and that wait for their buyer's
payment goes through, since that order was served, and so does a buyer's
payment presented again for an order already paid. While the rule holds, your
cards are not in the catalogue and a look at one of them is refused too.
Nothing is stored: it lifts by itself when a late delivery or a closure leaves
fewer than {{unserved-at-most}}, and your dashboard says so while it holds, paused or not. It is
not retryable, because only you can lift it and nothing says when, and it
charges nothing either.

An order your package cannot read, one carrying a field or an address shape
that the contract version it speaks does not allow, goes the way of a handler
that threw: it is not handed to your handler, nothing is answered, and it comes
again for up to {{redelivery-window}} after it was first handed over, as long as
its deadline allows, while everything else on the subscription goes on.
Your problem handler receives an `unread` problem naming the order and the
fields it could not read; a newer release of the package may read it ([When
Agentify is newer than your
package](/orders#when-agentify-is-newer-than-your-package)).

What each status word means and which of them stay on the list of open orders
is in [Finding out where an order stands](/orders#finding-out-where-an-order-stands);
how long each wait lasts is in [Every time limit](/orders#every-time-limit);
and how a repeat is recognised is in [Telling a repeat apart](/orders#telling-a-repeat-apart).
Whether your handler holds against a repeat is yours to prove with a test
purchase of your own ([The first test sale](/quickstart)),
because nothing on our side sends one order twice on purpose.

A call to Agentify can also fail on our side. It is answered with HTTP 500
and the code `gateway_failed`, and the message says what is known of what the
call did. A read that fails decided nothing, and it may be made again. A call
that changes something, such as publishing or pausing a card, delivering, or
closing fulfillment, may have done its work before it failed, so the answer
says that whether it changed anything is not known, and it is marked
retryable. Publishing, pausing and resuming, setting your seller name,
`deliver`, `accept` and `close` can be made again as they are. A refusal
cannot: read the order back with `get` before sending it again, as [When a
call on an order does not go
through](/orders#when-a-call-on-an-order-does-not-go-through) explains. An
answer to a price question that failed this way may already have priced the
purchase, and a repeat of it can be answered as not used even though the first
one was.

A purchase that fails after its payment arrived may have been charged, and the
agent is told that whether it was is not known. That answer is not retryable,
because the payment it carried may already be spent. The agent signs the same
payment request again from the same wallet, which is answered with the order
or with where its payment stands and never charges twice. Asking for a new
price instead starts a new purchase, which is charged again once paid. Where
the failure came before anything was written for the payment, for example
while Agentify waited for a database connection, the answer is HTTP 503 with
`gateway_failed`, marked retryable, with `Retry-After: 2`: the payment was not
used, and the agent sends the same request again. A purchase that fails before
any payment it could read is told that nothing was charged, and the agent asks
for the price again.

## Your integration has not connected

Agentify counts your integration as connected while a process of yours polls
for orders, which it does from the moment it calls `start()`. When no poll has
arrived for {{silent-after}}, or none has arrived yet, your cards leave the
catalogue and new purchases are refused, and your dashboard says so, with the
time of the last poll if there was one. The next poll brings them back, and
you do not have to switch anything on again.

When the dashboard says this, check the process that should be polling:

- It is running, and it has called `start()`. A process that crashed, was not
  started again after a deploy, or registered its handlers without starting
  does not poll.
- Its key still works. A poll made with a key you revoked on API keys is
  refused and does not count, and your problem handler receives a
  `poll_failed` problem each time.
- Its problem handler has not received `contract_version_mismatch`. After
  that problem the subscription has stopped, and the process stays up without
  selling until you upgrade the package ([When Agentify is newer than your
  package](/orders#when-agentify-is-newer-than-your-package)).
- Fewer than four of its messages are unfinished. An instance with four still
  running asks for nothing more until one finishes, so it does not poll either
  ([Running the handler in several
  instances](/orders#running-the-handler-in-several-instances)).
- It reaches the address you gave the client. A poll that does not get
  through is reported as `poll_failed` too.

A WooCommerce shop is never counted this way, because Agentify's connector
takes the shop's orders and nothing of yours polls, so while your shop sells
for you the dashboard does not say this.

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
