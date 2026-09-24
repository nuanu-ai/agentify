# Connecting to Agentify

*The public contract is versioned; changes arrive in a new package and contract version.*

You run an online business, and you are deciding whether it is worth putting
your goods where programs do the buying. This page is what that decision is
made of: who buys there, what we will ask you, what we take on ourselves, and
how connecting begins.

## Who buys here

Agentify puts the goods of an ordinary online business into the catalogues
where AI agents buy — the listings an agent searches when it is looking for
something, run by other people and not by you. An agent is a program that a
person handed a task and a budget; to finish the task it finds the goods it
needs, pays for them and takes delivery, all by itself.

For you that is one more place to sell. Your range does not have to change, the
prices stay yours, and your shop goes on working the way it works now. One
thing is different: on the other side of the sale, in place of a person who
opened your site and pressed the buttons, there is a program. It does not look
at pictures and does not read reviews. It decides whether to buy from the card
— the text that describes one of your products in a catalogue. How precisely
that text says what the buyer gets is what settles how many sales you end up
sorting out by hand.

The money goes from the buyer's wallet straight to yours, one transfer per
sale. It never passes through our accounts, and we take no percentage of it.
The moment the buyer is charged is not the same for every product: for some the
money arrives after you have delivered, for others at the moment of purchase.
That, and the rest of what there is to say about the money, is on
[Money](/money).

## What we will ask you

The conversation about connecting comes down to four questions, and once you
have answered them we have no more questions for you.

1. What you sell. Your integration publishes a card with the title,
   description, price and list of what has to be given at purchase. The card is
   the whole of what an agent reads, and your code republishes it when the
   product changes.
2. Where to send the money. We need the address of your wallet — buyers'
   payments arrive there. Nothing accumulates on our side, and nothing is paid
   out once a week.
3. Whether the product survives being delivered twice. The same order can reach
   you twice: a connection dropped, an answer never landed, we tried again.
   Access, a key, a link, a subscription go out a second time to the same buyer
   without loss; a unit off a shelf or a one-off code from a limited batch does
   not. During the pilot we take on goods of the first kind only, and that is
   our limit rather than a property of what you sell: we have not chosen how
   money goes back yet, so we sell what we are almost certain we can deliver.
   Once there is a way to send money back, the limit comes off
   ([Money](/money)).
4. How the goods are delivered. The working path uses the Agentify SDK: a
   handler runs beside your API, takes paid orders and gives out the goods. A
   WooCommerce connector is experimental and is not required for the SDK path.
   Delivery by a message that you confirm by hand is not available.

## Your hands or ours

Your engineer writes the handler against your API. The whole path from an empty
project to a test sale is on [The first test sale](/quickstart). Agentify carries
the paid order to that handler and returns its delivery to the buyer.

The WooCommerce connector is an experiment. It is not the route used to accept
the SDK product, and you do not need it for an SDK integration. Delivery by a
message that you confirm by hand is designed but not switched on.

## After you are connected

Your integration remains the source of the cards. When a product, its contents
or its price changes, your code republishes the card under the same product key.
Agentify publishes it in its own catalogue and carries paid orders to your
handler. Listing in an external discovery catalogue is measured separately and
is not guaranteed by publication or by a completed purchase.

You can stop the sales yourself at any moment. The cabinet is a page on our
side that you sign in to through a one-time link sent to your email, and it
shows your cards, your orders and the receipts for the sales that went through.
That account is not the key your code sends us, so ending someone's session
does not touch your integration. It carries a pause on each card and one button
that stops selling altogether. Paused, a card stops selling and disappears from
the catalogues, while the orders already taken on play out in the ordinary way.
Leaving is the other thing, and it does not tidy everything away either: the
orders nobody paid for close, and the ones paid for and not delivered become
money you send back.

We also mean to stop selling without your asking, when your side stops
answering or answers too often that the goods are gone — to the buyer that
looks like a promise the catalogue did not keep. That stop is designed and not
built: nothing today counts your refusals or takes your cards off sale on its
own, so during the pilot the switch is the one in your hands, and we watch the
rest with you. What it will look like when it exists is on [What can go
wrong](/failures).

Short answers — what this costs, what happens about refunds, who settles a
dispute — are collected in the [common questions](/faq).

## How to start

<a href="/cabinet/sign-in" target="_self">Open the cabinet</a>, enter your email address and
follow the one-time link in the message. Pressing its confirmation button
opens your cabinet. On your first visit, it asks for the seller name that the
buyer's payment request will show. You can then issue an API key and integrate
against the test channel.

On both the test and live channels, save the wallet where your USDC payments
arrive before publishing a card. The local scripted sandbox moves no money
and does not require a wallet. Live sales also require the operator's one-time
approval of your merchant; test sales do not. Publication lists every missing
prerequisite. [The first test sale](/quickstart) walks through the setup.

On the live channel, replacing a wallet you have already saved takes two days.
Every cabinet account of your merchant is sent a message about the change
first, and the new address takes effect forty-eight hours later; until then
your sales keep arriving at the address you had. The wait is there because the
wallet is the one setting that sends your money somewhere else, and any of
your keys can ask for a change: whoever asked, you hear about it and can
cancel it on the wallet screen of your cabinet. If you have lost access to the
old wallet, pause selling for those two days. The first wallet you save
applies at once, and on the test channel every change applies at once.

The first test purchase is started by an Agentify operator. If an operator is
already coordinating your pilot, give them the catalogue ID and keep your
handler running while they start it. There is no public request path for an
unassigned self-signup yet. Operator approval opens live publication after the
review.

## What is not settled yet

- What the subscription costs and what it covers.
- Reconciling the money. Orders are visible in the cabinet, but we write a
  receipt at the moment the goods are delivered, so an order that is paid for
  and not yet delivered appears among the orders and not among the receipts.
  The money arrives straight in your wallet, and putting the two together is
  still yours to do.
- What happens when a purchased period runs out: renewing a subscription and
  buying the same access again are not designed yet.
- What we promise you when it is our side that goes quiet. There is a great
  deal here about your side falling silent and nothing about ours.
- Stopping your selling without being asked. Nothing does it today, and what
  will count as your side having gone quiet, where the limit on "the goods are
  gone" answers sits, and how selling comes back are all open.
