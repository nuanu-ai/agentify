---
"@nuanu-ai/agentify-contracts": patch
"@nuanu-ai/agentify": patch
---

The descriptions say where a buyer's money goes now that Agentify takes a
commission. The payTo of every payment request is the merchant's payout
contract, a 0xSplits split with no owner, which keeps what it is paid until
anybody sends a payout and then sends 99.9% to the merchant's wallet and 0.1%
to Agentify. Each share is rounded down to the smallest unit of USDC, and one
unit stays behind on the payout contract and on each balance a payout credits,
so 1.000000 USDC paid into a new payout contract reaches the merchant's wallet
as 0.998998 at its first payout. Nobody, Agentify included, can change whom the
contract pays, and Circle, which issues USDC, can freeze USDC at any address,
the payout contract and the shared 0xSplits warehouse included.
`payout_wallet` keeps its name and shape and is where the merchant's share
arrives; it is never the payTo of a payment request, and what it receives is
one transfer per payout from the 0xSplits warehouse, not a transfer from each
buyer. A receipt's `transaction` is the buyer's payment into the payout
contract, and a refund owed is the whole price, paid from the merchant's own
wallet, while the commission stays with Agentify. The SDK's README says the
same. No schema, type or behaviour of either package changes, and
`CONTRACT_VERSION` does not move.
