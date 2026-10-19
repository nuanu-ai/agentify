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
owes a refund after.

## Every failure, mode by mode

| Situation | Synchronous | Asynchronous | A parcel | What you do |
| --- | --- | --- | --- | --- |
| The price check is silent | the sale goes on at the card's price | the purchase is refused before payment, and no order reaches you | as in the asynchronous mode | keep a synchronous card's price current, since in a silence it is the price of the sale |
| You refused | the purchase did not happen and nothing was charged | the order owes a refund (`refund_due`) | as in the asynchronous mode | refuse before the money where you can, in the answer to the price question; after it, refuse at once rather than wait out your deadline |
| Your handler threw, or your process fell over | the order comes again after a pause that grows with each attempt, up to five deliveries in all, while its deadline lasts | as in the synchronous mode | as in the synchronous mode | throw for a failure that may pass, and keep refusals for "this cannot be delivered" |
| No answer by the deadline | nothing was charged (`expired`) | the order owes a refund (`refund_due`) | the order owes a refund (`refund_due`) | name a deadline you can keep; goods or a shipment delivered late still close the debt |
| The same order arrived twice | answer with the result you gave the first time | as in the synchronous mode | record the same shipment | key your delivery on `order.id` and hand back the first result |
| The answer to the agent was lost | the agent signs the same payment request again from the same wallet and receives what you delivered, with no second charge | the agent signs the same payment request again from the same wallet and is answered with the order, with no second charge | as in the asynchronous mode | nothing; a repeat that does reach your handler gets the first result |
| The goods ran out | "there is none" in the price check refuses before payment; a refusal at delivery charges nothing | "there is none" in the price check refuses before payment; a refusal after it leaves a refund owed | as in the asynchronous mode | list goods that can run out with a price check, and answer it truthfully |
| The charge failed after your delivery | the buyer paid nothing and has no goods (`delivered_unpaid`); a repeat purchase that pays releases them | cannot happen: the charge comes first | cannot happen | decide whether to revoke what you gave out; the risk is one sale's price |
| Nobody knows whether the charge went through | after your delivery the order reads `payment_unresolved`, and a repeat purchase is refused | the order reads `payment_unresolved` before it reaches you, and owes a refund if the charge reports in later | as in the asynchronous mode | skip it in your loops over open orders and wait |

Silence from a price check is any of three things: no answer within five
seconds, a server error or a network failure in place of an answer, or an
answer that does not fit the declared shape. The timestamp inside an answer is
carried and not weighed, so an old one is not a silence. A refusal and its
message reach the agent word for word, so write the message for a stranger
([refusal codes](/cards#refusal-codes)).

What each status word means and which of them stay on the list of open orders
is in [Finding out where an order stands](/orders#finding-out-where-an-order-stands);
how long each wait lasts is in [Every time limit](/orders#every-time-limit);
and how a repeat is recognised is in [Telling a repeat apart](/orders#telling-a-repeat-apart).
Whether your handler holds against a repeat is yours to prove with a test
purchase of your own ([The first test sale](/quickstart)),
because nothing on our side sends one order twice on purpose.

## What is not settled yet

- Stopping your selling when your side goes quiet for a long time. Nothing
  does it today: pausing and resuming are yours, on the Cards screen of your
  dashboard. The stop is designed to work as that same pause, and neither its
  conditions — how many failures in a row and over what period — nor the way
  selling comes back afterwards is settled.
- The limit on the share of purchases that run into missing goods, which we
  mean to measure because to an agent such a purchase looks like a promise the
  catalogue did not keep. Nothing counts it yet.
- Whether an answer whose timestamp is too old counts as silence at all.
  Nothing weighs that mark today, so what counts as too old has not had to be
  decided.
- What happens when it is we who go quiet: how your side sees it, and what we
  promise in that case.
