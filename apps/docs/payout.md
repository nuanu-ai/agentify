# Sending a payout

You hold the wallet your business is paid into, and you want what has
accumulated in your payout contract now rather than when Agentify next
collects its own share. A payout is one transaction on the Base network: it
pays out every sale since the last payout, your share to your wallet and ours
to our balance in the 0xSplits warehouse, and it costs only the network's
fee. Why it works that way is on
[Money](/money#getting-paid-out).

## What Settings shows before you send it

The Get your payout section of Settings names what a payout sent now would
bring your wallet. Agentify works this out by asking the network to run the
payout without sending it, so the amount is what the contracts would pay at
the moment the page was drawn, with their rounding included. A buyer who pays
before you send adds to it. If Agentify's own payout goes out first, that one
brings your share to you instead, and yours then brings nothing more.

When a payout would bring nothing, Settings says so and offers no transaction
to send. When Agentify could not read the network, Settings says it does not
know what the payout would bring and still gives you the transaction. Sending
it then does no harm, since it can pay out only what is there, but it costs
the network's fee even when that is nothing.

## With a Coinbase Wallet

Coinbase Wallet sends payouts from Settings on the live channel only. On the
test channel, Coinbase's window refuses Base Sepolia for the wallets it
creates now, so there is no Coinbase button there; send the test channel's
payout from another wallet, as described below.

1. Open the Settings screen of your dashboard.
2. Press Pay out with Coinbase Wallet. Coinbase's window opens and asks you to
   approve the transaction; nothing is sent until you do.
3. Approve it. Your share reaches your wallet in that same transaction.

Once you approve it, Settings says that you asked Coinbase Wallet to send the
payout and that it accepted, with the amount the page showed. That means the
wallet accepted the transaction, not yet that the network has carried it out;
reload Settings to see what is left to pay out. Otherwise Settings says it
does not know whether the payout went out: when Coinbase's window closes
without confirming the payout, when the wallet's answer cannot be read, and
when no answer comes within ten minutes, after which the page stops waiting.
You may have approved the payout in Coinbase's window before it went away, so
in each of these cases reload Settings and look at what a payout would still
bring before you send another.

Settings says that nothing was sent only when the wallet stopped before the
payout was asked for. Coinbase's window closes the same way whether you closed
it or it stopped on an error of its own, so Settings does not say which; in
either case you can press again, or send the payout from another wallet as
described below. While Coinbase's window is open, pressing the button again
is safe: a second payout pays out only what the first left.

A wallet that holds nothing yet may have nothing to pay the fee with. Then
that first payout arrives when Agentify next pays out every payout contract.

## With any other wallet

The Settings screen gives the payout as three values for a transaction you
send yourself: the address it goes to, which is Multicall3; an amount of zero;
and its data. These steps were checked on 2026-10-15 by sending payouts from
MetaMask on the test channel and on Base itself.

1. Use a wallet that holds a little ETH for the fee: ETH on Base on the live
   channel, or test ETH on Base Sepolia on the test channel, which is worth
   nothing and which a faucet, a site that hands out test currency, gives
   away. The payout does not have to come from the wallet it pays.
2. Let the wallet put data into a transaction. In MetaMask the field for it
   stays hidden until Show hex data is turned on, under Settings →
   Transactions; other wallet apps name it differently, and some do not offer
   it at all.
3. Switch the wallet to the network the screen names: Base, or Base Sepolia on
   the test channel, and no other. Multicall3 sits at the same address on most
   networks, so the same transaction sent on another one can go through
   there, pay nothing out and still cost that network's fee.
4. Start a transaction to the Multicall3 address the screen shows, with an
   amount of zero, and paste the data whole.
5. Before you send it, check that the address your wallet is about to call is
   that Multicall3 address, that the amount is zero, and that the data is the
   whole of what the screen gives, with nothing cut off. Then send it.

Data pasted into a transaction from a web page is usually a warning sign,
because that is how people are talked into signing a transaction that empties
their wallet, and your wallet app may warn you about it. This transaction
cannot do that: Multicall3 makes each of its calls itself, so none of them
acts for the wallet that sent it, and the amount is zero, so the fee is all it
takes from that wallet.

It worked when the transaction is confirmed on the network and your wallet
shows one incoming USDC transfer from the 0xSplits warehouse, covering every
sale since the payout before.
