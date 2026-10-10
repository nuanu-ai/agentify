---
"@nuanu-ai/agentify-contracts": patch
"@nuanu-ai/agentify": patch
---

zod is required at exactly the version the gateway runs, 4.4.3, rather than by
a range. A merchant's install could take a newer zod that counts a string's
length differently, and then the SDK's offline card check passed a card that
publication refused (an emoji in a description of 500 counted once, not twice).
The two are one check again.
