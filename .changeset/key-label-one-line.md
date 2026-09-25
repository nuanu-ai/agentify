---
"@nuanu-ai/agentify-contracts": minor
---

`IssueKeyRequestSchema` now refuses a label longer than 100 characters, or one
carrying a line break, a tab or another control character. On the live
deployment the message that tells a merchant of a new key, or of a payout
wallet change made with one, names the key by its label, so a label is one
line a list and a message can show whole. Keys already issued are read back
under whatever they were named; `MerchantKeySchema` is unchanged.
