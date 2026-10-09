---
"@nuanu-ai/agentify-contracts": patch
---

The descriptions of the registration route, the two routes at `/v0/keys/dashboard`, the payout-wallet write and the list of keys no longer say the dashboard calls them with a key of its own: the dashboard calls the gateway inside the process the two share, and nothing calls those routes with such a key. A message about a payout wallet change also says which account's session asked for it.
