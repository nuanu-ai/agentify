# Connecting to Agentify

You run an online business, and you are deciding whether it is worth selling
to programs that buy on a person's behalf. This page is what that decision is
made of — who buys, who does what in a sale, what it costs and when the buyer
pays — and how connecting begins.

## Who buys here

Agentify publishes your products in its own catalogue, which AI agents read
and buy from. Catalogues run by other people may list them too, and nothing
guarantees that, and how many agents read Agentify's catalogue today is not
something we can tell you yet. An agent is a program that a person handed a
task and a budget; to finish the task it finds the goods it needs, pays for
them and takes delivery, all by itself.

For you that is one more place to sell. Your range does not have to change, the
prices stay yours, and your shop goes on working the way it works now. One
thing is different: on the other side of the sale, in place of a person who
opened your site and pressed the buttons, there is a program. It does not look
at pictures and does not read reviews. It decides whether to buy from the card
— the text that describes one of your products in the catalogue — so how
precisely that text says what the buyer gets settles how many sales you end up
sorting out by hand.

Buyers pay in USDC, a digital dollar, on the Base network, into a smart
contract made for your crypto wallet, which then pays your share into that
wallet. Turning USDC into money in a bank account happens outside Agentify.

## Who is who

| Who | What they do in a sale |
| --- | --- |
| The buyer's agent | a program acting for a person: it reads the catalogue, decides from the card, pays and takes the goods |
| Agentify | publishes your cards, asks the buyer for the payment, carries the paid order to you and your goods back to the buyer, and never holds the money |
| The facilitator | the payment service that checks the buyer's signed payment and executes it, into your payout contract |
| Your process, or your WooCommerce shop | your code, running beside your own systems, or your shop connected in the dashboard: it takes the paid order and delivers the goods |
| Your payout contract and your wallet | the contract receives every payment in full and pays it out, 99.9% to your wallet and 0.1% to us |

Agentify is in its pilot: it runs with its first merchants while the rules
that are not settled yet get settled, and a few rules on these pages hold only
until then, each saying so. There is no end date for the pilot yet.

## What it costs and where the money goes

The buyer pays the price on your card into your payout contract, which keeps
the money until it is paid out and then sends 99.9% to your wallet and 0.1% to
us. Nobody, Agentify included, can change whom it pays. Our 0.1% is inside
your price, and there is no subscription and no monthly fee. Your share
reaches your wallet when you send a payout from your dashboard, at any time,
or when we collect our own share, which pays out your contract too; there is
no fixed day for that. [Money](/money) draws the whole path and says what you
risk on the way.

## When your buyer is charged

When the money moves depends on what you sell, and you choose it product by
product:

| Your product | When the buyer pays | If you cannot deliver |
| --- | --- | --- |
| Handed over at once by your system: a key, a link, access | after you have delivered, as the last step of the purchase | the purchase does not happen and the buyer pays nothing |
| Takes longer to prepare: a profile to set up, a supplier to ask | at the moment of purchase, before you deliver | the paid order is recorded as unfulfilled: you deliver late or close it, and any refund is yours to arrange |
| A parcel a carrier takes, on the test channel only | at the moment of purchase, before you ship | as above: you ship late or close the order, and any refund is yours to arrange |

A WooCommerce shop's products are all charged at the moment of purchase, and
the choice is not yours there: the connector publishes a download as a product
that takes longer to prepare and a physical product as a parcel.

The same choices, with the words your engineer's code uses for them, are on
[Orders and fulfillment modes](/orders).

## What the dashboard asks for

You connect on your own, in the dashboard, and it asks for four things:

1. Your email address, where it sends a one-time sign-in link, or your Google
   account.
2. The seller name buyers see beside your products and in the payment they
   approve.
3. The address of your wallet on Base, where your share of every sale arrives;
   nothing of yours sits in an account of ours.
4. How the goods are delivered: an API key you issue for your engineer's code,
   or your WooCommerce shop's address, as the next section says.

What you sell then reaches the catalogue as cards, which your integration
publishes with the title, description, price and list of what has to be given
at purchase. The card is the whole of what an agent reads.

Whether your product survives being delivered twice is yours to decide before
connecting, since nothing in the dashboard asks it. The same order can reach
you twice, and access, a key or a link go out a second time without loss,
while a unit off a shelf does not. During the pilot we take on goods of the
first kind only, because how money goes back to a buyer is not settled yet
([Money](/money#if-the-buyer-did-not-get-the-goods)); a parcel on the test
channel, where the money is not real, is the one exception.

## Your code or your WooCommerce shop

| | Your code | Your WooCommerce shop |
| --- | --- | --- |
| Who builds it | your engineer, with the Agentify SDK, following [The first test sale](/quickstart) | nobody: the dashboard connects the shop and imports its products as cards |
| What it sells | anything your systems can deliver | downloads and parcels from the shop ([what can be imported](/woocommerce#what-can-be-imported)) |
| Where it sells | the test channel, then the live one | the test channel, until its orders have gone through there end to end |

You sell through one of the two at a time. A third way, an order sent to you as
a message that you confirm by hand before the buyer pays, is designed and not
available.

## After you are connected

Your integration remains the source of the cards: when a product, its contents
or its price changes, your code or the shop's import publishes the card again.

The dashboard is a page on our side that you sign in to through a one-time link
sent to your email. It shows your cards, your orders and the receipts for the
sales that went through, and that account is not the key your code sends us,
so ending someone's session does not touch your integration. You can stop the
sales yourself at any moment, with a pause on each card or one button that
stops selling altogether: a paused card stops selling and disappears from the
catalogue, while the orders already taken play out in the ordinary way.
Leaving altogether is not available yet: pausing and revoking keys end no
order already taken and delete no account, and the
[FAQ](/faq#can-i-leave-altogether) says what you can do instead. Nobody at
Agentify watches your orders for you, so keep an eye on them and pause selling
when your integration cannot deliver.

Short answers — what this costs, what happens about refunds, who settles a
dispute — are in the [common questions](/faq).

## How to start

1. Open the [test channel's dashboard](https://test.agentify.ad/dashboard),
   enter your email address and follow the one-time link in the message. On
   your first visit it asks for the seller name buyers will see.
2. In Settings, save the wallet where your share arrives; on the test channel
   it only ever receives test USDC. [Money](/money#if-you-have-no-wallet-yet)
   says how to get one, and replacing a wallet you saved on the live channel
   takes forty-eight hours ([why](/money#replacing-your-wallet)).
3. Hand over the integration: issue an API key for your engineer, who follows
   [The first test sale](/quickstart), or connect your WooCommerce shop
   ([how](/woocommerce)).
4. Make your first test purchase yourself: your engineer buys your own card on
   the test channel with test USDC, as [the guide's sixth
   step](/quickstart#_6-make-your-first-test-purchase) shows.
5. Go live: sign in to the live channel's dashboard at `https://agentify.ad`
   as a separate account, save a wallet for real money there, and have your
   cards published again with a live key. An Agentify operator approves your
   merchant once before anything sells live.

What changes between the two channels:

| | Test channel | Live channel |
| --- | --- | --- |
| Address | `https://test.agentify.ad` | `https://agentify.ad` |
| Account | sign in at its dashboard | a separate account: sign in again at its dashboard |
| Seller name | needed before the first card | needed again |
| Wallet | receives test USDC on Base Sepolia, which is worth nothing; a replacement applies at once | receives real USDC on Base; replacing a saved one takes forty-eight hours |
| API key | starts with `csk_test_` | starts with `csk_live_` |
| Your first purchase | you make it yourself, with test USDC | — |
| Agentify's operator | not involved | approves your merchant once before anything sells |
| Cards | published with a test key | published again with a live key; nothing is copied |
| WooCommerce | available | not yet |
| Parcels | sold | not sold yet |

## What is not settled yet

- A public way to ask for the operator's approval of the live channel.
- Reconciling the money. Orders are visible in the dashboard, but a receipt is
  written at the moment the goods are delivered, so an order that is paid for
  and not yet delivered appears among the orders and not among the receipts.
  The money reaches your wallet one payout at a time, each covering every sale
  since the payout before it, and putting the two together is still yours to
  do.
- What happens when a purchased period runs out: renewing a subscription and
  buying the same access again are not designed yet.
- What we promise you when it is our side that goes quiet.
- Stopping your selling without being asked, when your side stops answering or
  answers too often that the goods are gone. Nothing does it today, so the
  switch is the one in your hands, and what will count as your side having
  gone quiet and how selling comes back are open.
- When the pilot ends.
