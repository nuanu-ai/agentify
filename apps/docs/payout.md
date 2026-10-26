# Sending a payout

You hold the wallet your business is paid into, and you want what has
accumulated in your payout contract now rather than when Agentify next
collects its own share. A payout is one transaction on the Base network: it
pays out every sale since the last payout, your share to your wallet and ours
to our balance in the 0xSplits warehouse, and it costs only the network's
fee. Why it works that way is on
[Money](/money#getting-paid-out).

## With a Coinbase Wallet

1. Open the Settings screen of your dashboard.
2. Press Pay out with Coinbase Wallet. Coinbase's window opens and asks you to
   approve the transaction; nothing is sent until you do.
3. Approve it. Your share reaches your wallet in that same transaction.

Once you approve it, Settings says that Coinbase Wallet sent the payout. That
means the wallet accepted the transaction, not yet that the network has
carried it out. Otherwise Settings says it does not know whether the payout
went out: when Coinbase's window closes without confirming the payout, when
the wallet's answer cannot be read, and when no answer comes within ten
minutes, after which the page stops waiting. You may have approved the payout
in Coinbase's window before it went away, so in each of these cases look at
your payout contract before you send another. Its page on the block explorer,
linked beside your wallet on Settings, lists the transactions that reached it
and the USDC it holds now.

Settings says that nothing was sent only when the wallet stopped before the
payout was asked for: you closed Coinbase's window while it asked to connect,
the wallet did not move to the payout's network, or the page could not open
Coinbase Wallet at all. Then you can press again, or send the payout from
another wallet as described below.

A wallet that holds nothing yet may have nothing to pay the fee with. Then
that first payout arrives when Agentify next pays out every payout contract.

## With any other wallet

Under Send it from another wallet, the Settings screen gives the payout as
three values for a transaction you send yourself: the address it goes to,
which is Multicall3; the ETH to send, which is zero; and its data.

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
