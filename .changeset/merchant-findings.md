---
"@nuanu-ai/agentify-contracts": minor
"@nuanu-ai/agentify": minor
---

`MERCHANT_FINDINGS` and the `MerchantFinding` type name the three findings a
refused publish carries about the merchant rather than the card:
`no_seller_name`, `no_payout_wallet` and `no_operator_approval`. The gateway
already sent these codes, each with an empty path in the error's `problems`;
the constants let a program tell "fix the card" from "fix the merchant"
without spelling the words itself. The SDK re-exports both beside
`CARD_REJECTED`. The exported JSON Schema of a finding now describes its
`code` and names the three, and the description of a refusal's `problems`
says that its `message` names the merchant's missing settings plainly rather
than quoting the first finding. The description of a merchant's card list
now counts the live approval among the reasons a card reads paused, which it
already was. Nothing on the wire changes shape, so the contract version stays
where it is.
