---
"@nuanu-ai/agentify": minor
---

`checkCard` now applies the contract's price rule after the card's shape
passes, so it finds what publishing refuses about a price: zero, an amount
written with fewer than two digits after the dot, and a currency other than
USD or USDC. Each comes back as a finding on `price.amount` or
`price.currency`, in the words the publish call uses. A card priced `'5 USD'`
that passed the check before is now reported, because the gateway refuses it.
