---
"@nuanu-ai/agentify-contracts": patch
"@nuanu-ai/agentify": patch
---

The descriptions say where a buyer's money goes now that Agentify takes a
commission. The payTo of every payment request is the merchant's payout
contract, a 0xSplits split with no owner, which keeps what it is paid until
anybody sends a payout and then sends 99.9% to the merchant's wallet and 0.1%
to Agentify, each share rounded down to the smallest unit of USDC.
`payout_wallet` keeps its name and shape and is where the merchant's share
arrives; it is never the payTo of a payment request, and what it receives is
one transfer per payout from the 0xSplits warehouse, not a transfer from each
buyer. A receipt's `transaction` is the buyer's payment into the payout
contract, and a refund owed is the whole price, paid from the merchant's own
wallet, while the commission stays with Agentify. The SDK's README says the
same. No schema, type or behaviour of either package changes, and
`CONTRACT_VERSION` does not move.
