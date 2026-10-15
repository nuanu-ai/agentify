# Money

*The public contract is versioned; changes arrive in a new package version.*

You run an online business, and you are deciding whether it is worth putting
your goods where programs do the buying. The money side of that decision is
collected here: where the payments arrive, at what moment the buyer is charged,
what you are risking while that happens, and what we take.

## Where the money arrives

The buyer — a program, buying on behalf of a person — pays into your payout
contract: a contract on Base made for your wallet, which keeps the money until
it is paid out and then sends 99.9% to your wallet and 0.1% to Agentify.
Nobody owns it. Neither Agentify nor anybody else can change whom it pays or
in what shares, so a payout can only ever pay you and us, in those shares. We
check each payment and set it going, and no account of ours holds your money
at any point. USDC itself is issued by Circle, which can freeze USDC at any
address, your payout contract and the shared 0xSplits warehouse it pays
through included, for as long as the money waits there.

You can get paid out at any time. The Settings screen of your dashboard shows
your payout contract and the one transaction that pays it out. You send it
from any wallet that holds a little ETH, the currency Base charges its network
fee in, and whose app lets you paste data into a transaction ([Getting paid
out](#getting-paid-out) says how), and your share reaches your wallet in that
same transaction. The transaction carries no money
of its own and costs only that fee. If you do not send it, your share arrives
when Agentify collects its own, because collecting it pays out every payout
contract, yours included; there is no fixed day for that. Until somebody pays
it out, the money waits in the contract.

A payout pays out everything that came in since the one before, so the sales
between two payouts reach your wallet as one transfer, and that transfer comes
from the 0xSplits warehouse, the shared contract every payout contract pays
its shares through, rather than from a buyer. If your accounting is used to
one line per sale, there will be one line per payout instead, and it can
cover many sales.

Saving your wallet costs nothing and writes nothing to the chain: the payout
contract's address follows from your wallet, and it can receive USDC from that
moment. The first payout puts the contract itself on the chain, and from then
on a block explorer shows its two recipients and their shares.

A new wallet comes with a new payout contract, and the old contract goes on
paying the old wallet. Whatever is already in it is paid out to the old wallet
only, whoever sends the payout: if somebody else may hold that wallet's keys,
it is theirs to collect, and if you have lost access to it, it is lost with it.
On the live channel a new wallet takes effect forty-eight hours after the
change is announced, and buyers pay into the old contract until then, so if
you can no longer trust the old wallet, replace it at once and pause selling
for those two days.

### If you have no wallet yet

Your wallet is an address on Base, the network these payments run on: `0x`
followed by forty letters and digits. If your business has none, a wallet app
that supports the Base network, such as MetaMask, creates one. The app
shows the address, which is what you enter in the dashboard's Settings, and a
recovery phrase, which stays with you and is never entered anywhere at
Agentify: whoever holds the phrase holds the money. On the test channel your
wallet only ever receives test USDC, so it needs no money of its own.

### Getting paid out

The payout on your Settings screen is three values for a transaction you send
yourself: the address it goes to, which is Multicall3, an amount of zero, and
its data. Send it on the network the screen names, Base, or Base Sepolia on the
test channel, and on no other. Multicall3 sits at the same address on most
networks, so the same transaction sent on another one can go through there,
pay nothing out and still cost that network's fee. The steps below were
checked on 2026-10-15 by sending payouts from MetaMask on the test channel and
on Base itself.

Your wallet has to let you put data into a transaction. In MetaMask the field
for it stays hidden until Show hex data is turned on, under Settings →
Transactions; other wallet apps name it differently, and some do not offer it
at all. The payout does not have to come from the wallet it pays: any wallet of
yours whose app shows the field, and which holds a little ETH for the fee, can
send it.

On the test channel the fee is paid in test ETH on Base Sepolia, which is
worth nothing and which a faucet, a site that hands out test currency, gives
away. On the live channel it is paid in ETH on Base.

Data pasted into a transaction from a web page is usually a warning sign,
because that is how people are talked into signing a transaction that empties
their wallet, and your wallet app may warn you about it. This transaction
cannot do that: Multicall3 makes each of its calls itself, so none of them
acts for the wallet that sent it, and the amount is zero, so the fee is all it
takes from that wallet. Before you send it, check that the address your
wallet is about to call is the Multicall3 address the screen shows, that the
amount is zero, and that the data is the whole of what the screen gives, with
nothing cut off.

## What they pay in

Buyers pay in USDC, a digital dollar whose rate is pegged to the dollar. A card
may write its price in USD or USDC; either way the gateway asks the buyer for
the same number of USDC on the configured network. There is no exchange-rate
conversion in between, so a price in any other currency is refused when the
card is published, and so is a price check's answer written in one.

These payments have one more property worth knowing in advance: the transfer is
final. A buyer cannot reverse it the way a charge on a bank card is reversed,
because these payments have no such mechanism at all. The case familiar from
bank cards, where money is taken back off your account a month after the sale
and you are left proving the goods went out, does not happen here. Whatever you
give back, you give back yourself and by your own decision.

The test channel uses Base Sepolia and test USDC. The live channel uses Base
mainnet and real USDC. A local sandbox also describes Base Sepolia and USDC in
its payment challenge, but its scripted settlement moves no funds and records
no transaction on a chain. Test and sandbox receipts are marked as test; a
live receipt is not.

Who pays the network fee on a buyer's payment and how that fee sits against
the price of the goods is still unsettled.

## When the money reaches you

It depends on the product, because the moment the buyer is charged does. For
some goods the buyer is charged after you have delivered: the payment executes
as the last step of the purchase, and if the delivery did not work out, the
purchase simply did not happen — the buyer spent nothing and you owe nobody
anything. For the rest the buyer is charged at the moment of purchase, ahead
of your delivery, and then a product that was never delivered leaves a debt:
such an order is marked as needing a refund. Either way the payment goes into
your payout contract, and your share reaches your wallet with the payout after
it.

Which of the two comes first is your choice, and you make it product by product
— it is written in the card for that product, the description a catalogue shows
a buyer, alongside its price. There is no switch for the whole shop: one
product can be paid for after delivery and the one next to it before.

Say you sell a month of access for five dollars (an example figure). If the
access goes to the buyer in the answer to the purchase, those five dollars are
paid into your payout contract after your side has handed it over. If
preparing the access takes minutes or hours, the same five dollars are paid in
at the moment of purchase and you deliver later.

A third arrangement exists, for goods you hand over yourself, and it arrives
after the pilot. Before any money moves you are asked whether you will deliver;
until you answer yes nothing is charged, and after your yes the buyer is
charged at once, with the delivery still ahead of it.

One rule covers all three. While your answer comes before the money, your
silence costs the buyer nothing. After the charge, that same silence leaves
them without the goods — what that looks like in each separate failure is on
[What can go wrong](/failures). The exact moments of charging are collected in
a table for your engineer on [Orders and fulfillment modes](/orders).

## You delivered and the money did not arrive

This is possible for goods that are paid for after your delivery. We check the
payment first — the signature and the funds — then hand you the order, receive
the goods and only then execute the payment. Time passes between the check and
the execution, and in that gap the funds can leave the buyer's wallet for
something else.

What it can cost you is the price of one sale, so the only thing you have to
weigh here is how expensive and how irreversible your delivery is. Access you
can revoke and a parcel already on its way are worth different amounts to you.

You hear about such a case from us: we tell you the money did not arrive. There
is no need to reconcile the payments against what you delivered by hand.

Sometimes that is the whole of what anybody knows. Where the payment network
was asked and never answered, nobody can say whether the buyer was charged, and
the case can stay that way — so taking back what you gave out may be taking it
from somebody who paid for it. That is the case to weigh when you decide how
irreversible a delivery of yours should be.

Putting the money first closes the case. For a product paid for ahead of the
delivery, the charge happens at the moment of purchase and you never deliver
anything unpaid. Which comes first is yours to choose product by product, in
the card, and we do not set a general rule on your behalf.

## What proves a sale happened

A sale that went through leaves a receipt — a record of the payment, written at
the moment the goods are released. It shows what was bought and for how much;
to the buyer it is proof of payment, to you it is the record a dispute is
settled from. The price the sale went through at goes into the receipt and
stays there unchanged even after your price has moved.

A receipt carries three moments, and they are three different things. The
payment time (`paid_at`, "Paid" in the dashboard) is when the payment went
through. The price's `at` ("Price set") is when we fixed the price for this
sale. The price's `as_of` ("Price as of") is when that price was true: the
moment your price check said it held from, or, for a card sold at its own price,
when the card was published with it. The three are seldom the same moment: in
the synchronous mode the charge comes seconds after the goods, and on a card
whose price is checked at the purchase the agent may take minutes between the
price and the payment.

A receipt also names the buyer's payment itself (`transaction`): the hash of
the transfer into your payout contract that the payment layer reported, which
the dashboard links to the chain's explorer, so a receipt can be matched to
its payment without going by its time. That transfer goes into the contract
and not into your wallet, which receives the payouts instead, each covering
every sale since the payout before it.

An order paid for and never delivered leaves no receipt, because no goods went
out. What you have for that case is the order itself and the event telling you
a refund is owed.

Receipts matter for repeats too. The answer to a purchase is sometimes lost on
the way: the buyer paid and the goods did not reach them because the connection
dropped. The agent then repeats the purchase and receives what has already been
delivered. There is no second charge, and we do not ask you for a second
delivery. Which key we recognise a repeat by is in [Telling a repeat
apart](/orders).

## If the buyer did not get the goods

You return the whole price of an undelivered product to the buyer yourself,
out of your own wallet, although your payout contract pays you 99.9% of it:
the 0.1% commission stays with Agentify. The refund has to come from you,
because the contract pays only you and us and has no way to send a payment
back to a buyer, and it makes no difference whether that sale has been paid
out to you yet: what you owe the buyer is the price they paid. Our part of the
work is to record the obligation and hand you the record — which order, for
how much, and why it was left undelivered. That covers both the orders you did
not manage to deliver in time and the orders still open at the moment you
leave.

How the money travels back remains open. We are looking at how working sellers
do it and taking a pattern that works. What exactly you do during a refund is
not decided, and it is the largest open item in the money contract.

Until there is a way, the pilot's rule applies — the one we ask about when you
connect ([What we will ask you](/)): only goods that can be delivered a second
time are paid for in advance, and we repeat the attempt to deliver, up to a
limit, until the deadline named in the card. The rule narrows the case without
removing it: an order that could not be delivered at all remains possible. We
tell you about every such order separately, and during the pilot there are few
of them — but not none, and each one is dealt with by hand.

## What we take

We take 0.1% of every payment, and it is inside your price. The buyer pays the
price on your card and nothing on top of it, and your payout contract sends
99.9% of it to you and 0.1% to us. If you want what reaches you to be the
whole of a price you have in mind, raise the price on the card yourself. There
is no subscription and no monthly fee. The Settings screen of your dashboard
names the commission, and saving your wallet there is how you accept it.

The contract divides what has accumulated in it, not each sale on its own, and
rounds each share down to the smallest unit of USDC, a millionth of a dollar.
It also leaves one such unit behind on a balance rather than pay the network
fee of emptying it. So a payout gives you about 99.9% of what came in and
never more, and what the rounding leaves over is divided in a later payout.
For the same reason there is no exact commission to read off a single order.

Your share is paid out whenever somebody sends the payout transaction: you, at
any time, with the transaction your dashboard's Settings screen gives you, or
Agentify, when it collects its own share ([Where the money
arrives](#where-the-money-arrives)).

## What is not settled yet

- Who pays the network fee on a buyer's payment and how it sits against the
  price of the goods.
- How you send money back for an undelivered order, and how we learn that you
  have.
- Reconciling what came in against what was sold. Your wallet receives one
  transfer per payout, covering every sale since the payout before it, and
  nothing yet shows which sales a payout covered. A receipt follows the goods,
  so an order paid for and not delivered has none, and matching the payouts
  into your wallet against the orders is still yours to do by hand.
- The written terms of the commission. Until they are published, saving your
  wallet on the screen that names the commission is the whole of how you
  accept it.
- Who counts as the seller on paper, what document your accounting receives for
  a sale and for our commission on it, and how a stablecoin payment is
  reported.
