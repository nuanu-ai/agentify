---
"@nuanu-ai/agentify": patch
"@nuanu-ai/agentify-contracts": patch
---

A card's `fulfill_deadline_seconds` is refused at publication unless it is
between 60 and 2592000 seconds, a minute to thirty days. A shorter deadline
closed every paid order unfulfilled before the merchant's process could
answer, and a longer one had no limit at all. A card already stored with a
deadline outside that range is read back, listed and sold as it was stored.
