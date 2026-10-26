# Common questions

Short answers, each with a link to where the question is worked through in
full. The first half comes from what people ask while deciding whether to
connect; the second from what they ask once they sit down to write the code.

## Questions from the owner

### Do I have to rebuild my shop?

No. The shop, its range and its prices stay as they are; either your code
delivers through your own API beside the shop, or your WooCommerce shop is
connected as it stands. The two ways are compared on [Connecting to
Agentify](/#your-code-or-your-woocommerce-shop).

### Do I need an engineer for this?

For the SDK, yes: your engineer writes the integration that publishes your
cards and delivers paid orders through your API. A WooCommerce shop needs no
code and is connected in the dashboard, on the test channel for now ([Selling
through a WooCommerce shop](/woocommerce)).

### Can a restaurant or a hotel sell this way?

A card can describe a table, a room night or a pass, as long as your own system
can hold the booking and answer for it when the order arrives. During the
pilot we take on only goods that survive being delivered twice, and live
publication waits for our approval, so start on the test channel ([What the
dashboard asks for](/#what-the-dashboard-asks-for)).

### What does it cost?

We take 0.1% of every payment, and it comes out of the price on your card.
There is no subscription and no monthly fee ([What we
take](/money#what-we-take)).

### Do you write the product cards, or do I?

You do: your integration or your shop's import publishes them, and republishes
a card when its product or price changes. The card is the whole of what an
agent reads before buying ([The product card](/cards)).

### Will Agentify bring buyers to me?

Not by itself. Agentify publishes your cards in its own catalogue, where agents
that read it find them, and catalogues run by other people may list them too;
nothing guarantees that any agent buys, and how many read the catalogue today
is not something we can tell you yet. The buyers are programs carrying out a
person's instruction, so the person does not visit your site or write to your
support, and the program decides from the text of the card ([Who buys
here](/#who-buys-here)).

### How do I find out about a sale?

Your code receives the order, or your connected WooCommerce shop receives it as
a paid order, and the dashboard shows it under Orders. Whether the buyer has
paid by then depends on when your product charges ([When your buyer is
charged](/#when-your-buyer-is-charged)), and the receipt follows the goods
([What proves a sale happened](/money#what-proves-a-sale-happened)).

### Can I pause the selling?

Yes, at any moment: the Cards screen of your dashboard has a pause on each card
and one button that stops selling altogether, and your code can do the same
with a call. A paused card disappears from the catalogue, while the orders
already taken play out in the ordinary way ([After you are
connected](/#after-you-are-connected)).

### Can I leave altogether?

Not yet, and nobody at Agentify arranges it for you. You can pause all selling
and revoke your API keys in the dashboard, but neither ends an order already
taken or deletes your account. Before you switch off the integration those
orders need, deliver them, or close fulfillment of each on Orders with an
explanation for the buyer. A connected shop's keys stay valid until you revoke
them in WooCommerce → Settings → Advanced → REST API, and what is in your
payout contract can be paid out at any time, after a pause too ([If the buyer
did not get the goods](/money#if-the-buyer-did-not-get-the-goods)).

### A buyer paid and did not get the goods — what happens about a refund?

Agentify records the order as unfulfilled, and the rest is yours: deliver
late, close fulfillment with an explanation for the buyer, and send a refund
if you decide to. Agentify neither sends a refund nor checks one. What you
hold to reach the buyer with is on [If the buyer did not get the
goods](/money#if-the-buyer-did-not-get-the-goods).

### The buyer is unhappy — who settles the dispute?

You do, by your own rules, the same way you settle one in an ordinary shop. We
do not stand between you and the buyer; we hand you the order and the record of
what happened with the delivery and when, and a [receipt](/money#what-proves-a-sale-happened)
where the goods went out.

### What do buyers pay with?

USDC, a digital dollar, on the Base network: test USDC on Base Sepolia on the
test channel, real USDC on Base on the live one ([What they
pay in](/money#what-they-pay-in)).

## Questions from the engineer

### Who makes the first test purchase?

You do. You buy your own card on the test channel with an ordinary x402 client
and test USDC from a public faucet, and the order reaches your handler like
any other ([Make your first test
purchase](/quickstart#_6-make-your-first-test-purchase)).

### The goods ran out or the price changed — how do you find out?

We ask your price handler at the moment of purchase, where the card has a price
check; the sale goes at the price you name, and an answer of "there is none"
closes the purchase before any money moves. Without a check we sell at the
card's price and hear that the goods have run out from your refusal ([A price
worked out at the moment of
purchase](/cards#a-price-worked-out-at-the-moment-of-purchase)).

### The same order arrived twice — is that normal?

Yes. Orders are delivered at least once, so one arrives again after a dropped
connection, a restart or a retry of ours, and your handler answers with the
result it gave the first time ([Telling a repeat
apart](/orders#telling-a-repeat-apart)).

### What do I check myself with before publishing?

`agentify verify`, the command in the package, reads your card files offline
and reports what an agent could not do with them. Whether your handler holds
against a repeat is proved by a test purchase rather than by the check ([Check
the card offline](/quickstart#_5-check-the-card-offline)).

## What is not settled yet

- How leaving is done at all — no call makes it happen today — its timings, and
  what becomes of orders taken on at the last moment.
- What the records of a delivery contain, the ones we hand you to settle a
  dispute with.
- How a complaint reaches you at all: the buyer is a program, and the person it
  was buying for does not write to your support.
